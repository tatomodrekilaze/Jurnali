package ge.jurnali

import android.content.Context
import android.util.Base64
import android.webkit.CookieManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

private const val REFRESH_URL = "${SITE_URL}school-lms-back/resources/school/keycloak/refresh"

/**
 * The tokens onlineschool keeps in localStorage, mirrored here so they can be renewed
 * while the WebView is asleep. The WebView already keeps the same tokens in plain text
 * inside the app's private storage, so encrypting this copy would buy nothing.
 */
data class Session(
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Long,
    /** Wall-clock millis when the access token runs out. */
    val accessExpiresAt: Long,
) {
    /** Wall-clock millis when the refresh token runs out, from its own `exp` claim. */
    val refreshExpiresAt: Long get() = jwtExpiry(refreshToken)

    fun isAlive(now: Long = System.currentTimeMillis()) = refreshExpiresAt > now

    fun toJson(): String = JSONObject()
        .put("access_token", accessToken)
        .put("refresh_token", refreshToken)
        .put("expires_in", expiresIn)
        .put("access_expires_at", accessExpiresAt)
        .toString()

    companion object {
        /** Parses both the page's messages and the refresh endpoint's response. */
        fun fromJson(json: JSONObject, now: Long = System.currentTimeMillis()): Session? {
            val access = json.optString("access_token")
            val refresh = json.optString("refresh_token")
            if (access.isEmpty() || refresh.isEmpty()) return null
            val expiresIn = json.optLong("expires_in", 600)
            val expiresAt = json.optLong("access_expires_at", 0).takeIf { it > 0 } ?: (now + expiresIn * 1000)
            return Session(access, refresh, expiresIn, expiresAt)
        }

        private fun jwtExpiry(token: String): Long = runCatching {
            val payload = token.split(".")[1]
            val json = String(Base64.decode(payload, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP))
            JSONObject(json).getLong("exp") * 1000
        }.getOrDefault(0)
    }
}

class SessionStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("session", Context.MODE_PRIVATE)

    fun load(): Session? = prefs.getString("session", null)
        ?.let { runCatching { Session.fromJson(JSONObject(it)) }.getOrNull() }

    fun save(session: Session) = prefs.edit().putString("session", session.toJson()).apply()

    fun clear() = prefs.edit().remove("session").apply()

    /** The WebView's user agent, remembered so background requests look like the app's own. */
    var userAgent: String?
        get() = prefs.getString("user_agent", null)
        set(value) = prefs.edit().putString("user_agent", value).apply()
}

sealed interface RefreshResult {
    data class Renewed(val session: Session) : RefreshResult
    /** The server no longer accepts this session: logged out elsewhere or past its maximum age. */
    data object Ended : RefreshResult
    /** No network, server hiccup. Worth trying again later. */
    data object Failed : RefreshResult
}

/** Same request the site's HTTP interceptor makes. Blocking; call it off the main thread. */
fun refreshSession(store: SessionStore, session: Session): RefreshResult {
    val conn = URL(REFRESH_URL).openConnection() as HttpURLConnection
    return try {
        conn.requestMethod = "POST"
        conn.connectTimeout = 15_000
        conn.readTimeout = 15_000
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
        conn.setRequestProperty("Accept", "application/json")
        conn.setRequestProperty("Origin", SITE_URL.trimEnd('/'))
        conn.setRequestProperty("Referer", SITE_URL)
        store.userAgent?.let { conn.setRequestProperty("User-Agent", it) }
        // The site sits behind bot protection that tracks its own cookies; send them along.
        runCatching { CookieManager.getInstance().getCookie(SITE_URL) }.getOrNull()
            ?.let { conn.setRequestProperty("Cookie", it) }

        val body = "refresh_token=" + URLEncoder.encode(session.refreshToken, "UTF-8")
        conn.outputStream.use { it.write(body.toByteArray()) }

        val code = conn.responseCode
        when {
            code in 200..299 -> {
                val text = conn.inputStream.bufferedReader().use { it.readText() }
                runCatching { Session.fromJson(JSONObject(text)) }.getOrNull()
                    ?.let { RefreshResult.Renewed(it) }
                    ?: RefreshResult.Ended
            }
            code in 400..499 && code != 408 && code != 429 -> RefreshResult.Ended
            else -> RefreshResult.Failed
        }
    } catch (_: Exception) {
        RefreshResult.Failed
    } finally {
        conn.disconnect()
    }
}
