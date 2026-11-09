package ge.jurnali

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts

private const val SITE_HOST = "onlineschool.emis.ge"
private const val SITE_URL = "https://$SITE_HOST/"

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private val script by lazy { assets.open("jurnali.js").bufferedReader().use { it.readText() } }

    private var pendingUpload: ValueCallback<Array<Uri>>? = null
    private val pickFiles = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        pendingUpload?.onReceiveValue(uris.toTypedArray())
        pendingUpload = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    private inner class SiteClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val host = request.url.host ?: return false
            val inApp = host == SITE_HOST || host.endsWith("google.com") || host.endsWith("gstatic.com")
            if (!inApp) runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
            return !inApp
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (Uri.parse(url).host == SITE_HOST) view.evaluateJavascript(script, null)
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
