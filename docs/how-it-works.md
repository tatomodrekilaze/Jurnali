# How onlineschool.emis.ge works (teacher side)

Notes from reading the official web app (Angular 14, bundle `webpackChunkeROfficer_front`) and
watching its network traffic from a teacher account. Nothing here comes from private
documentation; it's all visible to anyone who opens the site's JS.

The full list of 370-odd endpoints is in [endpoints.txt](endpoints.txt).

## Transport

- REST + JSON under `https://onlineschool.emis.ge/school-lms-back/resources/school/`.
- `Authorization: Bearer <access_token>`. The token, `refresh_token` and `expires_in` live in the
  page's `localStorage`. Sessions expire after a while; the API then answers 401.
- Dates are `DD/MM/YYYY`, date-times `DD/MM/YYYY HH:mm:ss`.
- Business-rule failures come back as **409** with `{"errorCode": "..."}`. The site maps each code to a
  Georgian message in `assets/lang/ka.json` under `GROWL.*`.
- The login page has reCAPTCHA and an F5 bot-protection script (`/TSbd/...`, `TS*` cookies).

## Sessions

Login goes to Keycloak at `auth.emis.ge` (realm `emis`) through the site's own backend.

| Token | Lifetime |
| --- | --- |
| access token | 10 minutes |
| refresh token | 30 minutes, reset on every refresh |

The site's HTTP interceptor refreshes only when it is about to send a request and the access token
has under 10 seconds left:

```
POST keycloak/refresh
Content-Type: application/x-www-form-urlencoded
refresh_token=...
```

It stores the result in `localStorage` (`access_token`, `refresh_token`, `expires_in`,
`accessTokenExpirationDate`). Nothing refreshes while the teacher is idle, so a break of more than
30 minutes always ends at the login page.

On top of that the site has its own idle timer (`bn-ng-idle`, started with 600 seconds in the main
layout). After 10 minutes with no mouse, touch or key event it shows "გსურთ მუშაობის გაგრძელება
სისტემაში?" with a 10-second countdown. If nobody answers it calls `keycloak/logout` (which ends the
Keycloak session for good) and runs `localStorage.clear()`. The watcher listens for `mousemove` on
the document, so any such event resets it.

What Jurnali does about it:

- While the page is open it refreshes ahead of time, and again when the page comes back to the
  foreground. It sends a synthetic `mousemove` once a minute and clicks "გაგრძელება" if the prompt
  shows anyway.
- In the Android app the page reports every new token to the app (a `WebMessageListener` restricted
  to the onlineschool origin). While the app is in the background, an alarm that may fire in Doze
  renews the session every 12 minutes with the same request as above. When the teacher comes back,
  the newer tokens are written into `localStorage` before the page wakes up, and on a cold start
  before the site's own code runs (a document-start script). A logout from the site clears the
  app's copy.
- The session still ends when Keycloak's maximum session age runs out, or if the phone's battery
  saver stops the alarm. Then the teacher logs in again, and the password manager fills it in.

The login form renders the password field as `type="text"` with `autocomplete="off"` outside dev
mode, which is why browsers never offer to save it.

## Who sees what

A staff account can have several hats at once. The front end keeps them in `localStorage`
(`role`, `origin_role`, `mentor`, `psychologist`, `isDirectorAndMentor`, `hasMyClassGroups`).

| Hat | Georgian | What it unlocks |
| --- | --- | --- |
| Teacher | მასწავლებელი | Journals of the class groups they teach (`myClasses: true`) |
| Homeroom teacher | დამრიგებელი (`MENTOR`) | Read access to every subject of their class (`pupils/classgroups/mentor`), excused absences, semester developmental grade corrections |
| Other classes | სხვა კლასები (`OTHER_CLASSES`) | Classes they don't normally teach, e.g. covering a lesson |
| Psychologist | ფსიქოლოგი | `pupils/classgroups/psychologist` |
| Director | დირექტორი (`accessAs=DIRECTOR`) | Read-only journals; attendance edits are rejected (`DIRECTOR_ATTENDANCE_ERROR`) |

A **class group** (`classGroupId`) is one class + one subject + one teacher, e.g. "1ბ, მათემატიკა".
A **school class** (`schoolClassId`) is the class itself, e.g. "1ბ".

## Attendance

- Everyone is **present by default**. Only absences are stored.
- Mark absent: `POST gradebook/{lessonId}/pupils/{pupilId}/absence` (no body).
  Undo: `DELETE` on the same path. The POST answers `{"excusable": bool, "updated": bool}`;
  `excusable` is true when an excused-absence record already covers that day.
- Per pupil per lesson the journal returns `present`, `absenceModified` (someone touched it),
  `excusable`, `notInClass`, `locked`, and `definitiveAssessments` (grades).

### When a lesson can be edited

The official app checks this before letting the toggle work (`checkIfShowAddAssessment`):

```
now >= lesson start   AND   round((now - lesson start) / 1 day) <= thresholdDays[lessonType]
```

`thresholdDays` comes from `GET gradebook/definitiveassessment/thresholddays`. The response is
`{daysAfterLesson, daysAfterSummary, daysAfterSummaryRestore}` (8, 360 and 11 at the time of
writing); the official app maps it to `{SUMMARY_EXAM, SUMMARY_EXAM_RESTORATION, other}` before
the lookup. Eight days is enough for the common habit of noting absences on paper during the
week and entering them all on Friday, which is why Jurnali shows the week's days as buttons. Outside that window, edits only go through if a correction request was
approved (`GET gradebook/classgroup/{id}/gradecorrection/active`).

So **attendance can't be entered ahead of time**. A lesson opens when it starts.

### Server-side refusals worth knowing

| errorCode | Meaning |
| --- | --- |
| `ASSESSMENT_EXISTS` | Pupil already has a grade in this lesson, can't mark absent |
| `ABSENCE_EXISTS` | The reverse: can't grade an absent pupil |
| `PAST_ABSENCE_ERROR` | Edit window has closed |
| `FUTURE_ABSENCE_ERROR` | Lesson hasn't started |
| `MOVED_PUPIL_ATTENDANCE_ERROR` | Pupil moved to another school |
| `PUPIL_IS_EXAM_RESTORATION_PARTICIPANT` | Pupil is registered for a make-up exam |

## Excused absences (საპატიო გაცდენები)

Separate records covering a date range, entered by the homeroom teacher:

```
POST excusableabsence
{ "schoolClassId", "pupilId", "startDate": "DD/MM/YYYY", "endDate": "DD/MM/YYYY", "comment" }
```

Absences that fall inside the range are flagged `excusable` automatically.

## Grades (not used by Jurnali yet)

- `POST gradebook/{lessonId}/pupils/{pupilId}/definitiveassessments`
  `{ value, assessmentType, includeSemesterCalculation, comment }`
- Edit / delete: `PUT` / `DELETE gradebook/definitiveassessments/{id}`
- Allowed types for a pupil: `GET gradebook/{lessonId}/pupils/{pupilId}/definitiveassessments`
- Elementary classes (`GET gradebook/classgroup/{id}/elementary`) send `value: null`; they're graded
  with comments and developmental (განმავითარებელი) assessments, which are questionnaire answers:
  `POST gradebook/{lessonId}/pupils/{pupilId}/improvementassessments { topicNumber, answers }`.

## Reading a day

What Jurnali does to build one screen:

1. `GET dashboard/schedule?date=` returns the teacher's events for the day, each with its class groups.
2. For each class group, `GET gradebook/classgroup/{id}/week?accessAs=TEACHER&startDate=&endDate=`
   (same date twice) returns that day's lessons with ids and the full pupil list.
3. Schedule entries and journal lessons are matched by start time.
