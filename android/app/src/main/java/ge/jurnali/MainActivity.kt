package ge.jurnali

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

const val SITE_HOST = "onlineschool.emis.ge"
const val SITE_URL = "https://$SITE_HOST/"
private const val SITE_ORIGIN = "https://$SITE_HOST"

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var store: SessionStore
    private var seedHandler: ScriptHandler? = null
    private val script by lazy { assets.open("jurnali.js").bufferedReader().use { it.readText() } }

    private var pendingUpload: ValueCallback<Array<Uri>>? = null
    private val pickFiles = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        pendingUpload?.onReceiveValue(uris.toTypedArray())
        pendingUpload = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = SessionStore(this)
        store.userAgent = WebSettings.getDefaultUserAgent(this)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true // the site keeps its session token in localStorage
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.builtInZoomControls = true
            settings.displayZoomControls = false
            webViewClient = SiteClient()
            webChromeClient = UploadClient()
        }
        setContentView(webView)

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true) // reCAPTCHA on the login page
        }

        listenToPage()
        updateSeed()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        if (savedInstanceState == null) webView.loadUrl(SITE_URL) else webView.restoreState(savedInstanceState)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    // Pausing the WebView fires visibilitychange in the page, which is what the
    // script listens to for renewing the session when the teacher comes back.
    override fun onResume() {
        super.onResume()
        KeepAlive.foreground = true
        // Hand over whatever the background refresh got while we were away, before the
        // page wakes up and tries its own (by now expired) token.
        updateSeed()
        if (Uri.parse(webView.url ?: "").host == SITE_HOST) {
            store.load()?.let { webView.evaluateJavascript(seedScript(it), null) }
        }
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        CookieManager.getInstance().flush()
        KeepAlive.foreground = false
        if (store.load()?.isAlive() == true) KeepAlive.schedule(this)
        super.onPause()
    }

    /** The page reports every new token and an explicit logout. Only our site can post. */
    private fun listenToPage() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        WebViewCompat.addWebMessageListener(webView, "jurnaliNative", setOf(SITE_ORIGIN)) { _, message, _, isMainFrame, _ ->
            if (!isMainFrame) return@addWebMessageListener
            val json = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return@addWebMessageListener
            when (json.optString("type")) {
                "session" -> Session.fromJson(json)?.let {
                    store.save(it)
                    updateSeed()
                    if (!KeepAlive.foreground) KeepAlive.schedule(this)
                }
                "logout" -> {
                    store.clear()
                    updateSeed()
                    KeepAlive.cancel(this)
                }
            }
        }
    }

    /**
     * Puts our tokens into localStorage before the site's own code runs on the next page
     * load, so a cold start opens straight into the journal instead of the login page.
     */
    private fun updateSeed() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        seedHandler?.remove()
        seedHandler = store.load()?.let { WebViewCompat.addDocumentStartJavaScript(webView, seedScript(it), setOf(SITE_ORIGIN)) }
    }

    private inner class SiteClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val host = request.url.host ?: return false
            val inApp = host == SITE_HOST || host.endsWith("google.com") || host.endsWith("gstatic.com")
            if (!inApp) runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
            return !inApp
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (Uri.parse(url).host != SITE_HOST) return
            // Older WebViews without document-start scripts still get the session, just later.
            if (seedHandler == null) store.load()?.let { view.evaluateJavascript(seedScript(it), null) }
            view.evaluateJavascript(script, null)
        }
    }

    private inner class UploadClient : WebChromeClient() {
        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            pendingUpload?.onReceiveValue(null)
            pendingUpload = callback
            pickFiles.launch("*/*")
            return true
        }
    }
}

/**
 * Writes [session] into the page's localStorage under the keys the site uses, but only
 * if it's newer than what the page already has, and only if the site's other login state
 * (role and so on) is still there. If that's gone, the teacher really did log out.
 */
private fun seedScript(session: Session) = """
    (function (s) {
      function exp(t) {
        try {
          var p = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
          return JSON.parse(atob(p + "===".slice((p.length + 3) % 4))).exp;
        } catch (e) { return 0; }
      }
      try {
        if (!localStorage.getItem("role")) return;
        var mine = localStorage.getItem("refresh_token");
        if (mine && exp(mine) >= exp(s.refresh_token)) return;
        if (exp(s.refresh_token) * 1000 <= Date.now()) return;
        localStorage.setItem("access_token", s.access_token);
        localStorage.setItem("refresh_token", s.refresh_token);
        localStorage.setItem("expires_in", String(s.expires_in));
        localStorage.setItem("accessTokenExpirationDate", new Date(s.access_expires_at).toString());
        if (document.readyState !== "loading" && location.pathname.indexOf("/auth") === 0) location.replace("/");
      } catch (e) {}
    })(${session.toJson()});
""".trimIndent()
