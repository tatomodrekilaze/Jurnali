# Jurnali

A lighter front end for the [onlineschool.emis.ge](https://onlineschool.emis.ge) teacher journal.

Marking attendance on the official site means opening the journal for every class and subject, one lesson at a time. If a child is out sick, the teacher marks them absent four or five times a day. Jurnali shows the day's lessons and the class list on one screen: tap the kids who are missing, save once, done.

- **Absences carry forward.** A child marked absent in the first lesson is pre-selected for every later lesson that day, so after each lesson saving is a single tap. Anything already set by hand on the site is left alone.
- **Follows the journal's own rules.** Lessons unlock when they start and lock when the edit window closes, exactly like the official site. A pupil who already has a grade is never marked absent.
- **Opens where you need it.** The class with the lesson running right now is selected automatically.
- **Catch up on missed days** with ‹ and ›, as far back as EMIS allows.
- **Stays logged in.** The site logs teachers out after 10 idle minutes and again whenever they're away for half an hour. Jurnali answers the "continue working?" prompt for them, and the Android app keeps the session alive while the phone is locked. The login page is fixed so the phone offers to save the password.
- **Checks its own work.** After saving it reads the journal back and marks every lesson ✓ or ✗, with EMIS's own error message when something was refused.

**Download:** [tatomodrekilaze.github.io/Jurnali](https://tatomodrekilaze.github.io/Jurnali/)

## How it works

Jurnali doesn't log in on its own and never sees a password. It runs on top of the real onlineschool page after the teacher has signed in there, and uses the same API the site does.

- **Android**: a WebView app that opens onlineschool and injects `web/jurnali.js`.
- **Desktop**: a bookmarklet that loads `web/jurnali.js` from GitHub Pages into the onlineschool tab.

Both run the same script.

Before writing anything it checks that the API responses look the way it expects. If EMIS changes something, saving is switched off and teachers are told to use the site as usual. After saving, the journal is read back and every lesson gets a ✓ or ✗.

`web/config.json` is fetched on every open. It can override API paths, disable the tool remotely (`"disabled": true`) or force an update (`"minVersion"`), so most breakages can be fixed without shipping a new APK.

## How onlineschool works

[docs/how-it-works.md](docs/how-it-works.md) covers the API, roles (teacher, homeroom teacher, director), the attendance edit window, excused absences and grades. [docs/endpoints.txt](docs/endpoints.txt) lists every endpoint the official web app calls.

## Development

```
web/        script, config and landing page (published to GitHub Pages)
android/    WebView wrapper
```

The quickest way to work on the script is to open onlineschool in a desktop browser, log in, and paste `web/jurnali.js` into the console. Set `window.JURNALI_DRY_RUN = true` first and writes are logged to `window.JURNALI_DRY_LOG` instead of being sent.

Building the APK locally needs JDK 17, the Android SDK and Gradle 8.11:

```
gradle -p android assembleDebug
```

CI builds a signed APK on every push to `main` and attaches it to a release when you push a `v*` tag. Signing needs three repository secrets: `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`.

## Disclaimer

Not affiliated with EMIS or the Ministry of Education. Use at your own risk and double-check the journal on the official site until you trust it.

## License

MIT
