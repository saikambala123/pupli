# Appli-Fill — what changed

## 1.27.0 — Work eligibility on every application; relatives; ADP currency; saved answers across companies; start date

Every change below is covered by a test; the suite is now **2004 checks, all
passing** (`npm test`). Two new spec files, each confirmed to fail against
1.26.0:
- `adp-wfn-questions` (18/46 passed on 1.26.0) fills the reported Workforce Now
  Questions step — a credit union's own questions as SDF radio groups and
  react-select lists, the conflict-of-interest box ("If no, enter NA"), Date
  Available, the desired salary with Annually / Hourly, the amount and "Select
  currency type", and "Did any of our current employees inform you about this
  position?" — with the page focused and from the popup, with the currency list
  drawn four ways, and presses the page's own Next. It answers questions by
  hand on one company's application and checks they are filled on the next
  company's.
- `eligibility-wording` (22/51 on 1.26.0) asks the same eligibility, relatives,
  referral, relocation and start-date questions in the other wordings
  companies use, on an ordinary (Greenhouse) page, and checks nothing is
  invented when the profile is silent.

### Relatives employed by the company: a new profile answer

- **Portal.** Profile → Work eligibility → **"Do you have any relatives
  employed by this company?"** (Yes / No). Saved with the profile
  (`workAuth.relativesEmployedHere`); it has no default, so nothing is claimed
  until you choose.
- **What went wrong.** There was nothing to answer from. "Are you related to
  anyone currently employed by Acme?" was taken by the prior-employment rule and
  answered with whether *you* had worked at Acme; every other wording was left
  blank on every application.
- **Fix.** "Do you have any relatives employed by Acme?", "Are you related to
  anyone currently employed by …", "Is anyone in your immediate family employed
  by …", "Does Acme employ any of your relatives?" are answered from the
  profile on every company's application. A question that also asks about
  friends is answered only by a Yes. A box that asks for names gets what the
  page says to enter for a no ("If none, enter N/A"), and is left for you when
  the answer is Yes. Questions about officials, competitors, clients or an
  industry are not this question and are left alone.

### Work eligibility, in the other wordings

- **At least 18**: "Are you under the age of 18?" (answered the other way
  round), "…at least 16?" (yes for anyone over 18), "…21 or older?" (from a date
  of birth on the profile). "At least 18 years of experience" is no longer read
  as an age.
- **Worked here before**: "Are you a former Acme employee?", "Have you ever been
  an employee of Acme?", "Prior employment with Acme?", "a current or former
  Wells Fargo team member" were left blank. A stored Yes no longer answers "Are
  you *currently* employed by Acme?" — the work history does.
- **Willing to relocate**: "This position requires relocation to Des Moines.
  Are you willing to relocate?", "…at your own expense?" and "…with relocation
  support?" were refused as questions about relocation assistance. Only a
  question about needing help with a move is refused now.
- **"Did any of our current employees inform you about this position?"** and
  "Were you referred by a current employee?" — No when the profile says you
  heard of the job on LinkedIn (or another source that is not a referral) and
  Referred by names nobody ("." counts as nobody); Yes when Referred by names
  someone. Left blank before.
- The answers come from the profile, so they are the same on every company's
  application; the work history still decides "Have you worked for Acme?" when
  Acme is on it. On Workforce Now, whose address names no company, the company
  is also read from the page where it names one (its title, site name or
  company label), so "Have you worked for us?" can be checked too.

### ADP: Currency type was never chosen

- **What went wrong.** No rule used Compensation → Currency, and the list itself
  was passed over: a control called "Select Currency Type" was taken for a
  website's currency switcher, the kind the scan ignores.
- **Fix.** The currency saved in the profile is chosen (USD → "United States
  Dollar ( USD )", INR → "Indian Rupee ( INR )"), whether the list names itself,
  is named only by its placeholder, or only by the words it draws, and on
  Workforce Now's react-select lists too. Any portal that asks for the currency
  as a list gets it. Annually / Hourly now also follows the profile's Period
  (per hour → Hourly).

### Saved answers apply on every company's application

- **ADP radio groups.** The question was read as one of the group's own answers
  (Workforce Now names the group with `<label for>`, Recruiting Management with
  `aria-label`). A saved answer for it could never be found, and an answer you
  gave by hand was banked under the section heading ("Questions") or not at all.
  The question is read from the label now.
- **ADP answers given by hand.** A click on an ADP radio group, list or check
  box, and typing into an ADP box, reached the page as the component, which
  nothing mapped back to the control — so your answer was taken for the page's
  own doing and never offered to save. They are held for saving now, under the
  question, with the company's name.
- **The same question from another company.** A saved answer to "…employed by
  Globex?" already answered "…employed by Acme?". It now also does when the
  saved question says "this company", "the organization", "our firm", "us" —
  which is how a question is usually written in Saved Answers — and for the
  eligibility questions the profile leaves blank (worked here before,
  relatives). A Yes about one company (worked there, family there) is never
  carried to another.
- Saved answers keep the company they were given to (`lastCompany`, sent with
  each answer and returned to the extension), so a question that names the
  company somewhere unusual is still recognised on the next application.
- **The conflict-of-interest box** ("Do you have any additional jobs in the
  financial services … industry? If yes, … list employer and type of work. If
  no, enter NA.") was taken by the current-employer rule: it was given your
  employer's name, or — with no job to take one from — left blank and closed to
  the "NA" you had saved for it. It is an ordinary question now, answered from
  Saved Answers.

### Available start date

- **Wordings that were left blank**: "Date Available", "Available Date", "How
  soon can you start?", "When could you start?", "If offered a position, when
  would you be available to begin work?", "Earliest date you can start", "When
  can you join?". They get the profile's date (today for "Immediately", or for a
  date already past), written the way the box takes it.
- **Asked as choices** ("Immediately", "Within 2 weeks", "1-3 months", "More than
  3 months", as a list or radio buttons): the choice that covers your start —
  six days away is "Within 2 weeks", or "1 week" where that is offered. "Can you
  start within two weeks of an offer?" is Yes or No from the same date. With no
  start date on the profile, the notice period decides.
- **Notice period asked as choices**: a notice of "0" is "Immediate".

### Server

- `Profile.workAuth.relativesEmployedHere`; the resume parser passes it through.
- `SavedResponse.lastCompany`; `/api/extension/sync` accepts `company` with each
  answer, and `/api/extension/bootstrap` returns it.
- The answer drafter is told the profile's previous-employment and relatives
  answers.

---

## 1.26.0 — Oracle: the address validated and every field filled; ADP applications fill

Every change below is covered by a test; the suite is now **1907 checks, all
passing** (`npm test`). Three new spec files, each confirmed to fail against
1.25.0:
- `oracle-cx-live` (38/149 passed on 1.25.0) fills both reported Oracle
  Recruiting pages — Personal Info (section 1) and Application Questions with
  Diversity Information (section 2) — drawn from Oracle's live markup: its own
  list boxes, its Yes / No questions and check boxes drawn by their labels, and
  Title as pills. It runs with the page focused and from the popup, with lists
  that only the keyboard moves, with a slow server, with an address Oracle
  fills nothing from, with no such address in Oracle's search, and on a site
  whose lists are Oracle JET's (`oj-select-single`). The page's own Next is
  pressed at the end, and its own check has to pass.
- `adp-myjobs` (30/140 on 1.25.0) fills ADP Recruiting Management
  (myjobs.adp.com): Contact Information, the prescreening questions,
  Employment History and Voluntary Self-Identification.
- `adp-wfn` (63/89 on 1.25.0) fills ADP Workforce Now's Career Center
  application: personal information, questions and self-identification.

And one that passes on 1.25.0 and has to keep passing: `cross-site-guards`
(17 checks) fills ordinary application pages with the questions the Oracle and
ADP work touches — a salary asked as ranges, Yes / No radios whose question is
the first radio's label, a certification's "Title", consent and preferred-name
check boxes, a form drawn inside the page's own shadow root — and checks each
is answered exactly as 1.25.0 answered it (see "Nothing changes on other
sites" below).

`oracle-cx` and `oracle-cx-redwood` now expect Title to be chosen, the
non-compete question to be answered (as a draft), and ZIP Code, City and State
to be chosen from their own lists when Oracle's search has no such address.

### Oracle Address Line 1: typed, but never validated

- **What went wrong.** Oracle's address search lists its suggestions as rows
  of a grid, not as list options, so 1.25.0 never saw them: the street was
  typed and left there ("8451 GATE PKWY W APT 128"), and Oracle threw it away
  when the box was left. The apartment was also part of the search, and
  Oracle's search finds nothing for "… APT 128".
- **Fix.** The street is searched without the apartment (with your city and
  state when the street alone finds other towns first), and the suggestion
  with your house number and street is picked from Oracle's own list. The
  apartment goes into Address Line 2.
- **ZIP Code, City, State and County.** Oracle fills them from the address
  picked. Anything still empty a moment later is chosen from its own list —
  ZIP Code first (it brings the City, State and County with it), then City and
  State — and County is the one Oracle offers for the address. When Oracle's
  search has no such address, Address Line 1 is outlined for you, and ZIP
  Code, City, State and County are still chosen.

### Oracle lists, Yes / No questions and check boxes left empty

- **Lists** (Gender, Veteran Status, Sex at Birth, the "visually identified"
  lists, State, ZIP Code, City): the typed search text was read back as the
  answer, so they looked chosen while Oracle emptied them. The answer is now
  searched for in Oracle's own list, the row clicked (or chosen with the arrow
  keys and Enter, where a list only takes the keyboard), and the box read
  back: only a choice the list keeps counts. Lists drawn by Oracle JET
  (`oj-select-single`) are answered the same way.
- **Yes / No / NA questions and check boxes** are drawn at 0 × 0 behind their
  labels, and were never collected. They are now answered through their
  labels, under the question of their own row: authorized to work, former
  employee, and the races (only the one in your profile is ticked).
- **Title** is chosen from the gender in your profile (Mr., Ms., Mx.); left
  alone when you decline to self-identify, and never put in the "Title" of a
  licence, certificate or the like. (A title saved in your profile is used as
  before, on every site.)
- **"I choose not to disclose my sex / my ethnicity or race"**: No when your
  profile gives the answer, Yes when you decline.
- **Restrictive covenants (non-compete, non-solicitation)**: no profile holds
  the answer and almost everyone's is No, so it is answered No and shown as a
  draft to check (a saved answer for the question wins). Only on Oracle and
  ADP applications, where the blank question was reported.
- **The protected-veteran categories and the discharge date** are left blank
  and not outlined: they apply only to protected veterans.
- **Tax District**, like County, is the one Oracle offers for the address when
  it offers only one.
- Oracle's address search is given 15 seconds in all; a search that finds
  nothing no longer holds the fill for half a minute.

### ADP applications: nothing was filled

- **What went wrong.** ADP Recruiting Management (myjobs.adp.com) builds every
  question from ADP's SDF web components. The box you type into sits inside its
  component's shadow root, where no label reaches it, so every box read as
  "off | input" and matched nothing. The lists, radio groups and check boxes
  draw their own choices, and every write to a box inside a shadow root was
  refused because the box did not count as being on the page. Workforce Now's
  questions use the same radio groups.
- **Fix: the questions are read.** A box takes the label of its
  `adp-form-group`, of its component, or of the question printed in the row
  above it, and the section it sits in (Contact Information, Employment
  History, Voluntary Self-Identification).
- **Lists** are opened and the choice clicked, searched for through the list's
  own filter box when it is long (Florida for "FL", Texas for "TX", United
  States and not United States Minor Outlying Islands), scrolled to when the
  list draws its rows a few at a time, and read back. A list that has no such
  choice is closed with its filter box emptied again, and outlined for you.
  **Radio groups** and **check boxes** are clicked and read back. A consent
  box (a background check) is ticked only when your profile says yes.
- **Phone** goes in as ten digits beside ADP's country list, without the +1.
- **Employment History**: each job goes into its own block, "Add Employer" is
  pressed for the next one, the current job gets "I currently work here" and no
  end date. A date that has a month but no day is written as the first of the
  month, as ADP's date box takes a whole date.
- **Workforce Now**: Address Line 1 is a Google Places box. Your street is
  typed and, where Google lists your address, picked (the apartment goes to
  Address Line 2); otherwise the street stays as typed, never retyped with the
  city added. Newer Maps builds mark the box as a list; it is still the street,
  not "a location". "I have a preferred or chosen name" is left clear unless
  your profile has a preferred name, and the desired salary is counted
  Annually (Hourly for an hourly figure) beside the amount.
### Nothing changes on other sites

A review of the Oracle and ADP work found several pieces that reached past
those portals. On an ordinary application page they changed answers 1.25.0
got right. Each now applies only where it was needed, and `cross-site-guards`
checks that the ordinary pages are filled exactly as before:

- A salary asked as ranges ("$80,000 - $100,000 per year") was answered with
  the first range, as if it asked Annually or Hourly. The pay basis is now
  answered only on ADP's pages, and only when every choice is a pay period.
- A Yes / No question whose `<label for>` names its first radio read that
  radio as the question, so "Yes" was never picked. Reading a radio by its
  label is Oracle's way of drawing them, and is used only there.
- Title was put in a certification's "Title" box, and in a Prefix list,
  from your gender. That title is now chosen only on Oracle.
- Consent boxes (a background check, a drug test), "I have a preferred or
  chosen name", and "I choose not to disclose my race" were ticked wherever
  they appeared. They are now answered only on ADP's pages (the last one on
  Oracle's and ADP's), as the profile says.
- A form drawn inside the page's own shadow root had its job titles read as
  "Title" (Mr.), both Work Experience rows filled with the first job, and the
  whole app outlined. Boxes inside shadow roots are now handled only on ADP's
  pages. Other sites are read exactly as in 1.25.0.
- Oracle's list rows, its "No results" row and its toggle buttons are read
  only on Oracle's pages. The protected-veteran categories and the discharge
  date are handled only on Oracle's and ADP's pages, and a Google Places street
  box marked as a list only on ADP's, where they were reported.

The provenance spec held a fixed start date that has since passed, and a start
date in the past is replaced with today's, so the check failed from 2 October
on any version. It now uses a date a month after the day it runs.

---

## 1.25.0 — Start date from Workday's own calendar; Oracle phone number and Address Line 1

Every change below is covered by a test; the suite is now **1512 checks, all
passing** (`npm test`). One new spec file, confirmed to fail against 1.24.0:
- `oracle-cx-redwood` (15/47 passed on 1.24.0) fills Oracle Recruiting's
  refreshed Personal Info page as reported: Phone Number as one row with its
  Country code, and Address Line 1 as a list you type into. The page's own
  Next button is pressed at the end, and its own check has to pass. It runs
  with the page focused and from the popup, with the row's label linked and
  not, with a number box that says nothing about itself, with suggestions slow
  to arrive, with the same street in five other towns, and with phone numbers
  saved as "+1 516-205-8456", "+15162058456" and "1 (516) 205-8456".

`workday-sei-questions` gains nine checks (72; 67 pass on 1.24.0). Its date
widget can now refuse typing, and has Workday's calendar button. Run against
1.24.0, it shows exactly the reported 01/01/2000. `react-commit` gains six
(37; 35 on 1.24.0): the self-identification Date with a calendar, both with the
page focused and from the popup.

### Workday Available Start Date: "01/01/2000" again

- **What went wrong.** When a box did not take the typed date, 1.24.0 tried
  the arrow key, as other Workday fillers do. On a box that is empty, or that
  ignores typing, Workday's ArrowUp gives the box its first value: 01, 01 and
  2000. That is the 01/01/2000 in the report.
- **Fix: the arrow keys are gone.** The date is picked from Workday's own
  calendar, the button beside the boxes, as you would pick it: today with the
  calendar's "today", or the profile's date by turning to its month and
  clicking the day. That is the page setting its own date, so it is kept
  however the boxes treat typing. The calendar is closed again afterwards.
- **Which date.** The profile's Available Start Date when one is saved;
  otherwise today's date, exactly. A saved date already past is today too,
  since a form will not take a start date in the past.
- **A date left by an earlier fill** (01/01/2000) is cleared first, so the
  calendar opens on this month. If the boxes will not clear, the calendar is
  turned from January 2000 to this month.
- **Without a calendar,** the date is typed one keystroke at a time. Each
  keystroke is complete (keydown, keypress, beforeinput, textInput, input,
  keyup), and every box is read back. A date that still will not show is
  outlined for you, never left as 01/01/2000, and not counted as filled.
- The Voluntary Self-Identification of Disability **Date** uses the calendar
  the same way.

### Oracle Personal Info: Phone Number empty

- **What went wrong.** The refreshed page draws Phone Number as one row: a
  "Country code" list (+1) and, beside it, the box for the number. Because the
  row held two controls, the number box was taken for part of the
  country-code picker. It was left empty, or described as "Country code".
- **Fix.** The number box is recognised as Phone Number and gets your number
  as digits (5162058456). The +1 is already in the Country code box, so a
  number saved as "+1 516-205-8456" or "+15162058456" goes in without the
  code. The Country code is left as it is. Oracle keeps the number when the
  box is left, and that now happens from the popup too.
- Only Oracle's Candidate Experience pages are affected. Everywhere else, the
  phone number is written exactly as before.

### Oracle Address Line 1: typed, and your address picked from its suggestions

- **What went wrong.** The refreshed Address Line 1 is a list you type into
  ("Enter your street name and other address details to see suggestions").
  As a list it matched no rule, so it was never typed into. It keeps only an
  address picked from its suggestions: typed text that is not picked is thrown
  away when the box is left.
- **Fix.** Your street is typed, Oracle's suggestions are read, and the one
  that is your address (same number and street, and your ZIP Code or city) is
  clicked. If the street alone brings up the same street in other towns first,
  it is searched again with your city and state.
- **ZIP Code, City, State and County are never typed into or picked by
  Appli-Fill on that page.** Oracle fills them from the address picked in Address
  Line 1.
- **When no suggestion is your address,** nothing else is picked. Address
  Line 1 is outlined for you and not counted as filled, and ZIP Code, City,
  State and County are left for the address you pick there.
- Older Oracle pages whose Address Line 1 keeps a typed street are unchanged.
  When no suggestion is picked there, ZIP Code and City are still picked from
  their own lists.

---

## 1.24.0 — Start dates that fill, the self-identification Name and Date, and answers the page keeps

Every change below is covered by a test; the suite is now **1450 checks, all
passing** (`npm test`). Two new spec files, each confirmed to fail against
1.23.0:
- `react-commit` (17/31 passed on 1.23.0) fills real React 18 forms: Workday's
  My Information and Self Identify steps, and an Ashby application. Each is
  filled twice, once with the page focused and once as it is while the popup
  is open. Then the page's own button is pressed, and the page's own check has
  to pass.
- `start-date-other` (8/15 on 1.23.0) covers the start date on Greenhouse and
  iCIMS pages.

`workday-sei-questions` gains ten checks (63; 53 pass on 1.23.0). Its page can
now put the questions inside one group, as SEI's can. Run against 1.21.0 it
shows exactly the reported 01/01/2000; against 1.23.0, the reported empty date.

### Workday Available Start Date empty (and, before it, "01/01/2000")

The date itself was never the problem. Another box on the page was.

- **What went wrong.** A Workday page can wrap all its questions in one group.
  Appli-Fill found a date's boxes by looking inside the nearest such group, so
  every other box in it was taken for part of the date. The bonus question's
  answer, "20000", was read as the year 20000, and typing it "into the date"
  wrote 01/01/0000 over Available Start Date. Workday shows that as
  01/01/2000.
- **Why it got worse in 1.23.0.** From 1.22.0, Appli-Fill read the date back, saw
  it was wrong and emptied it. The bonus box was never filled either.
- **Fix: only the date's own boxes are the date.** A box that sits beside the
  date is never written as part of it.
- **Fix: only real dates are read as dates.** Amounts, percentages and words
  are not: "20000", "120000", "10%" and "Marketing 2019" were all read as
  dates before.
- **The date is written the way that has always registered on Workday:** each
  box typed in turn, then read back. A box that does not show its number is
  tried again three other ways: moved onto it with the arrow key, as other
  Workday fillers do; typed a digit at a time; then set outright.
- **A date the widget will not show is no longer emptied.** It is outlined
  for you and not counted as filled. It had been counted as filled, because a
  box showing "01" was taken as matching "10/01/2026".

### Workday Voluntary Self-Identification of Disability: Name and Date empty

Same cause. On the CC-305 step, Name, Employee ID and Date sit in one group.
The Name box was taken for part of the date, and Appli-Fill "wrote" your name as a
date. Nothing went into Name, and the Date beside it was given up on, so both
stayed empty. Name now gets the signature name from your profile (or your full
name), Date gets today's date, and Employee ID stays blank.

### Filled boxes showing validation errors: Workday name and address, Ashby Name

A fill starts from the extension's popup, and while the popup is open the page
does not have the focus. Chrome then moves the caret without telling the page:
no focus or blur events, and no change event when a box is left.

- **Why it failed.** Workday's name and address boxes, like many React forms,
  keep what was typed only when the box is *left*. The page never saw them
  left.
- **What you saw.** The name sat in the box while Save and Continue said
  "The field First Name is required and must have a value". Ashby's Name
  failed the same way on Submit.
- **Fix.** When the browser stays silent, Appli-Fill now tells the page itself
  that a box was entered and left, as a person's click and Tab would. When
  the page does have the focus, nothing extra is sent.
- Ashby's Yes / No buttons were already answered correctly and are unchanged.

### Start dates on other applications

A date input, a MM/DD/YYYY box and "When can you start?" in words were
already filled. The one shape that never was: a start date asked as three
lists (Month, Day, Year, or MM and YYYY). Each list now gets its own option
for the profile's date, or today's ("October", "Oct" or "10"; "1" or "01";
"2026"). A month saved from an earlier application is never replayed there.

---

## 1.23.0 — A popup that opens cleanly, settings that stay put, a welcome, and a sign-out that asks

Every change below is covered by a test; the suite is now **1394 checks, all
passing** (`npm test`). Two new spec files, each confirmed to fail against
1.22.0: `popup-open` (6/20 passed on 1.22.0) renders the popup frame by frame
against a worker that takes a moment to answer, as a sleeping service worker
does, with real scrollbars; `portal-signout` (0/9) renders the dashboard's own
Sidebar — compiled with the project's TypeScript, on its React, icons and
Tailwind — with the router and the logout request recorded. `npm run test:ui`
now runs both UI specs.

### Extension popup: "blinking like an error" on every open

The popup opened on "Connect your account" — the page's default — and swapped
to the paired view a moment later, when the background worker answered, each
view fading in.

- Nothing is drawn now until the right view is known. The view from the last
  time the popup was open is remembered — the plan, profile names, settings
  and a count, never profile details — and drawn before the first paint, then
  confirmed by the worker: unchanged, the page is left as it is; changed, it
  is redrawn in place; disconnected, it becomes the pairing view. The very
  first time, the popup waits for the worker instead of guessing.
- The fade on every open is gone.

### Extension popup: Fill settings moved the popup left and right

Opening Fill settings made the popup taller than the 600px a popup may be. The
window grew a scrollbar, the browser widened the window to make room for it,
and a popup anchored to its toolbar icon grows leftwards — so it moved left,
and back right when the settings closed. The popup now scrolls inside itself,
with the scrollbar's room kept whether or not it shows: its width never
changes.

### Welcome on the first connection

After the first successful Connect on a browser, "Welcome to Appli-Fill Autofill"
plays for three seconds — the bolt draws itself and strikes, a charge rolls out
from it, three form fields fill — then the popup as usual. A click skips it. A
browser that was already connected, or that connects again later, goes
straight to the popup.

### Dashboard: sign out asks first

The sign-out icon beside your name opens "Are you sure you want to log out?"
with Cancel and Log out. Cancel has the focus, so a reflex Enter keeps you
signed in, and Escape or a click outside does too. The browser extension stays
connected either way.

---

## 1.22.0 — Available Start Date: the profile's date, or today's, every time

Every change below is covered by a test; the suite is now **1365 checks, all
passing** (`npm test`). `workday-sei-questions` gains thirteen checks (53; 42
pass on 1.21.0) and its date widget two more behaviours: one that reads
keystrokes itself, and one that shows 01/01/2000 whatever date it is given.

### Workday: Available Start Date still "01/01/2000"

- **An old saved answer was replayed.** A start date saved off an earlier
  Workday application — "01/01/2000" — answered Available Start Date on every
  application after it, because a saved answer to the exact question outranks
  the profile. A start-date box now never takes a saved answer, and a start
  date is never banked as one: it is the profile's date when the profile has
  one, and today's date otherwise. A question asked in words ("When can you
  start?") still takes a saved answer in words ("Immediately", "Two weeks"),
  never a saved date.
- **A date already past is replaced.** A start-date widget already showing a
  day that has passed (01/01/2000 left by an earlier fill) is filled again
  with the profile's date or today's. A date still ahead is left as it is.
- **Typed like a person, then checked.** The date goes in month, day, year, a
  keystroke at a time, with the page rendering between keystrokes — the Self
  Identify date and "Today's Date" too. The widget is then read back. If it
  shows some other date, the boxes are set outright; if it still shows some
  other date, it is emptied and outlined for you. A wrong date is never left
  behind as if it were an answer.

---

## 1.21.0 — Disability question, How Did You Hear About Us, start date that sticks, sexual orientation and transgender

Every change below is covered by a test; the suite is now **1352 checks, all
passing** (`npm test`). Two new spec files, each confirmed to fail against
1.20.0: `ashby-survey` (16/33 passed on 1.20.0) and `workday-source-prompt`
(9/18). `workday-sei-questions` gains three checks and its date widget now
behaves like Workday's, a React component (27/40 on 1.20.0); `ui-regressions`
gains four. New fixtures: `ashby-survey.html` (Chainalysis's voluntary survey:
an introduction about accommodations, radio questions printed with
typographic apostrophes, Sexual Orientation as a type-to-search list) and
`workday-source-prompt.html` (SEI's My Information: How Did You Hear About Us?
as a prompt in categories, searched or browsed). `workday-app-questions` is
now asked on the day its profile was written for: its "2021 to now" role
crossed five and a half years on 1 October, and the check expecting "2-5
years" began to fail on any build.

### "Do you live with a disability?" left blank (Ashby, Chainalysis)

- Chainalysis words its No as "No, I don’t have a disability or have a
  history/record of having a disability". The Yes wordings were tested first
  and "or have a history" is one of them, so the No option was read as a Yes;
  both options sat on the Yes branch and a "No" profile matched neither. An
  answer that opens with Yes or No is now that answer, and a denial ("don't
  have a disability") is recognised before the words it contains.
- "I don’t wish to answer" with a typographic apostrophe is read as declining
  (on this form that also fixes declining Gender Identity).
- The disability question is no longer refused because a survey's
  introduction ("If you need an accommodation because of a disability…")
  travels with it; only the question's own words decide whether it is an
  accommodation request.

### Sexual orientation and transgender, in the profile

- **Profile → EEO** has two new questions: **Sexual orientation**
  (Heterosexual, Gay, Lesbian, Bisexual, Pansexual, Asexual, Queer, Prefer to
  self-describe, Prefer not to say) and **Do you identify as transgender?**
  (Yes, No, Prefer not to say). They are saved with the profile and sent to
  the extension; "Decline to self-identify on all applications" declines both.
- The extension answers "Sexual Orientation" — Ashby's type-to-search list,
  radios, menus, boxes to tick — matching the survey's own wording
  ("Straight/Heterosexual", "Gay or Lesbian", "Bisexual and/or pansexual"),
  and "Do you identify as transgender?". An LGBTQ+ membership question is
  neither, and "Is your gender identity the same as the sex you were assigned
  at birth?" (whose Yes means No) is left alone.

### Workday: How Did You Hear About Us? typed, not picked

It is a prompt: the answer has to be picked, as a pill, from a list in
categories ("Job Board ›", "Social Media ›"). The profile's answer was typed
into the search box, which Workday throws away, and Save and Continue said
the field was required — while Appli-Fill counted it as filled.

- The profile's answer is searched and the entry that is that answer picked
  ("LinkedIn", "Indeed"). Where the search finds nothing, the list is browsed:
  the answer at the top, then inside the categories it would be filed under
  (Social Media, then Job Board, for LinkedIn). A list of categories only is
  answered with the right category, as the menus without categories already
  were; "Company Website" finds "SEI Careers Website".
- An answer already given is left as it is; with nothing in the profile the
  question is outlined for you and nothing is typed into it.

### Workday: Available Start Date "01/01/2000"

- Each of the three boxes had been handed the whole date, so the first box
  wrote all three in one go. Workday's date widget applies each box's change
  to the date as it last rendered, and does not render again until the
  script pauses, so the boxes written together were lost. Each box now gets
  its own part — month, day, year — and is written on its own, the way the
  Self Identify date is. A whole date that does reach one box is written one
  box at a time, with a pause between.
- **Today's date by default**: the profile's date when it holds one (or
  "Immediately", "2 weeks"…), and today's date when it holds nothing or
  nothing a calendar can hold ("Negotiable"). The Self Identify date and
  "Today's Date" are today's date, as before.

---

## 1.20.0 — Yes/No questions, Workday start date and school, social links, Lever location that submits

Every change below is covered by a test; the suite is now **1294 checks, all
passing** (`npm test`). Four new spec files, each confirmed to fail against
1.19.0: `ashby-yesno` (4/20 passed on 1.19.0), `workday-sei-questions` (15/37),
`workday-education-prompt` (12/30; 1.19.0 has no school matcher for its last
seven to call) and `lever-location-pick` (7/16). New fixtures:
`ashby-yesno.html` (Chainalysis's application: Yes / No buttons with Ashby's
hidden mirror checkbox, the pressed button painted on the next render),
`workday-sei-questions.html` (SEI's Application Questions: the MM / DD / YYYY
widget and "Select One" menus, labels drawn as Workday's formLabel labels or as
legends) and `workday-education-prompt.html` (School or University as a search
prompt with look-alike schools, Field of Study, Social Network URLs).
`lever-location.html` can now hold its search behind Lever's hCaptcha check (a
token that arrives late, or a challenge a person must pass) and refuses to
submit a typed location that was never picked.

### Yes / No questions left blank (Ashby, jobs.ashbyhq.com/chainalysis-careers)

"Are you legally authorized to work…", "Will you now or in the future require
sponsorship…" and "Have you been previously employed by Chainalysis…" were left
blank, and not even outlined. Ashby draws each as a Yes and a No button with a
zero-size checkbox beside them that mirrors the pressed button; that checkbox
made the row look like "buttons plus another control", so it was never
recognised as a question.

- The mirror checkbox is read as the row's value store: each row is one Yes /
  No question, labelled by its question and answered from the profile. The
  checkbox is never collected as a question of its own.
- Ashby marks the pressed button a moment after the click. The answer is read
  back after that, so an answered question is no longer counted as a failure.
- A question the profile can't answer is outlined for you.

### Workday Application Questions (SEI): Available Start Date, Yes / No, salary

- **Available Start Date "01/DD/2022", "Error: Invalid Date: 01//2022".** The
  label of the question above it ("Employment Type Desired") was read as a
  heading over every question below, and its "employment" handed Available
  Start Date to the work-history date rule, which wrote the current job's start
  — month and year, no day. A label that belongs to another question is no
  longer taken for a heading, and the work and education date rules never take
  a question that asks when you are available.
- **"Immediately" is today's date.** The profile's Available start date is free
  text, and only a written-out date was understood. "Immediately", "ASAP",
  "Right away" and "Now" are today; "2 weeks", "Two weeks' notice" or "30 days"
  count from today; a date is that date, and a date already past is today. All
  three boxes (MM, DD, YYYY) are written. A question asked in words ("When can
  you start?") gets your own words.
- **"Do you wish to be considered for other opportunities?"** is answered Yes
  and shown as a draft to check; a saved answer for the question still wins.
  Newsletter, marketing and talent-community consents are never answered this
  way. The same question drawn as Yes / No buttons (Ashby) too.
- **"What are your expectations with regards to base salary?"** is the
  desired-salary question, filled from the profile. The bonus question beside
  it is left alone.
- Shift Preference, which the profile doesn't hold, is left outlined for you.

### Workday: School or University not filled

School or University is a search prompt: the school has to be searched and a
result picked. Appli-Fill typed the name and moved on, which leaves text Workday
throws away, and Save and Continue then says the field is required.

- The profile's school is searched (then, if need be, without the campus or
  place after it, without "The", with "&" as "and", and by its distinctive
  words), and the result that **is** your school is picked: the same name in
  any word order or punctuation, with a campus after it, or its initials
  ("MIT"). A different school that only shares words — "Northwestern
  Polytechnic University" for Northwestern University, "University of Illinois
  at Chicago" for University of Illinois — is never picked.
- A school the employer's list doesn't carry is answered "Other" where the list
  offers it, shown as a draft to check. When two different schools fit equally
  well, nothing is guessed: the box is outlined and left without stray search
  text.
- A school already picked is left as it is.

### Workday: Social Network URLs empty

- **LinkedIn** is found by its address as well as its type, so a LinkedIn link
  saved as "Other", "Portfolio" or "Personal website" (what a résumé import or
  an unchanged type menu can leave) fills "Please provide your LinkedIn URL:".
  Twitter/X is found the same way (twitter.com or x.com).
- **Facebook** is filled from a facebook.com link on the profile; with none,
  the box is left empty and not outlined.

### Lever: Current location filled, application refused (jobs.lever.co/palantir)

Lever submits only a place picked from its own list (the hidden
`selectedLocation`), never text typed into the box. The box read
"Jacksonville, FL, USA", but nothing had been picked:

- Lever's lookup sits behind an hCaptcha check, and a page's first search can
  wait on it for several seconds. The first search is now given 4 seconds, and
  up to 8 while Lever shows it loading; if the first keystrokes were dropped
  because the check wasn't ready, the search is asked for again.
- Typed text with no place picked is no longer taken as an answer: a later
  Fill picks the place.
- When Lever wants a person to pass its check first, nothing can be picked
  during the fill. The box is outlined and counted as needing you (never as
  filled), the note says "Click into Current location and Appli-Fill will pick
  your city from its list", and clicking into the box finishes the pick (for
  two minutes after the fill). Typing a different place yourself stops it.
- Text you type yourself into Lever's location box or a Workday search prompt
  is not typed over on a later Fill.

---

## 1.19.0 — Oracle Recruiting application filled, Lever location picked

Every change below is covered by a test; the suite is now **1191 checks, all
passing** (`npm test`). New spec `oracle-cx` (78 checks, 26 of them passed on
1.18.0) with a new fixture, `oracle-cx-apply.html`: Oracle Recruiting Cloud's
Candidate Experience application as the Yum! Brands posting draws it — pills,
read-only lists, type-to-search ZIP Code and City, Address Line 1 suggestions,
the diversity checkboxes. `lever-location` gains five checks and its fixture
now behaves like the live page (the search answers most of a second later and
the list only shows while the box has focus); 1.18.0 fails ten of them.

### Oracle Recruiting (…/CandidateExperience/…/apply/section/1)

- **Yes/No questions unanswered.** Oracle draws every list of ten or fewer
  values as a row of "pills": option buttons in a listbox, each in its own
  `<li>`, or plain buttons each in a wrapper of their own. Only bare sibling
  buttons were recognised, so none of these questions was collected. Every
  such row is now one question, labelled by the question around it (never
  "Yes"), answered from the profile, saved answers or the AI — which is now
  sent the choices too — and still reported as yours when you change it.
  Title (Mr./Ms.…) is left for you.
- **State, County, Tax District, Veteran Status empty.** They are read-only
  boxes that open a list, and every read-only box was treated as locked. A
  read-only box that says it opens a list is now answered from the list.
- **ZIP Code and City empty and "required".** They are lists searched as you
  type. The text was typed and the box left at once — Oracle throws away text
  that was never picked from its list — and the third of a second allowed for
  the list was over before the server answered. The box now keeps the caret,
  the wait lasts until the list arrives, and the matching entry is picked
  (JACKSONVILLE, never JACKSONVILLE BEACH).
- **Address suggestions left open.** The suggestion that is your own address
  (same number and street, and your ZIP Code or city) is picked, which fills
  ZIP Code, City, State and County the way Oracle wants them; those are then
  kept rather than typed over. An apartment the suggestion drops goes into
  Address Line 2. No suggestion is picked on a guess; the list is closed.
- **County and Tax District**: when the address leaves a single choice, it is
  taken; with several, they are left for you.
- **"What compensation are you seeking?"** is the desired-salary question, in a
  one-line or a multi-line box.
- **Diversity**: "I am Hispanic or Latino." as one checkbox is the Hispanic
  question (ticked for Yes, left clear for No), and "Select the races you
  identify with." is the race question. The Hispanic box is no longer lumped
  in with the race boxes below it.
- **"Have you been employed or contracted by Yum! in the past six months?"** is
  the worked-here question, and names like "Yum! Brands" are read whole, so a
  saved "relatives at GDIT?" answer also answers "relatives at Yum! Brands?".
- A hidden "This field is required." no longer counts as the page rejecting a
  field; that was retyping Address Line 1 over the picked suggestion.
- Middle Name, Title, Suffix and Address Line 2 are no longer outlined when
  you have nothing for them and the form does not require them.

### Lever: Current location empty

Lever looks places up on its server and shows them only while the box has the
caret. Appli-Fill typed the place and left the box in the same moment, so the list
never appeared and nothing was picked — and a board that keeps only picked
places emptied the box. The caret now stays until Lever's own suggestion is
picked, a search that is still loading is waited for (up to 3.5s), and a "No
location found" left over from the previous search is not taken as the answer.

---

## 1.18.0 — Dashboard reload error, Ashby location, passwords in Pending, Workday ethnicity

Every change below is covered by a test; the suite is now **1108 checks, all
passing** (`npm test`). Three new spec files, each confirmed to fail against
1.17.0: `ashby-location` (4/10 passed on 1.17.0), `account-password` (3/10) and
`workday-disclosures` (4/11). New fixtures: `ashby-location.html` (Ashby's
Location combobox with a server-side suggestion list, countries-only or
places), `workday-create-account.html` (centric.wd501's Create Account with
its "I consent" box) and `workday-disclosures.html` (uchicago.wd5's Voluntary
Disclosures with an ethnicity checkbox list).

### "Application error: a server-side exception has occurred" on reload

A full reload renders the dashboard frame and the page on the server, and both
start by loading the account from the database. On a serverless host the
process is frozen between requests, and when it wakes the cached database
connection can still report itself open while its sockets are gone — the first
query fails, and with no error screen anywhere in the app that became the bare
framework error page. (Reproduced locally with the database unreachable: the
same `MongooseServerSelectionError`, same page.)

- A connection idle for 30 seconds is pinged before it is reused, and one the
  driver has already dropped is replaced; the account lookup behind every page
  and API call, and each dashboard page's own query, retry once on a fresh
  connection.
- Dashboard pages send a signed-out visitor to sign in instead of throwing.
- Any page that still fails shows **"This page didn't load"** with **Try again**
  and **Sign in again** and a reference number, and retries itself once
  automatically, instead of the dead-end error.

### Ashby: Location left empty

- **The question was refused.** The location rule's denials ("office", "job",
  "role") were tested against the question's description as well as its label,
  and Brellium's reads "…four days a week from our Flatiron office". Only the
  box's own label counts now.
- **It was filled as a dropdown.** Ashby's box is an `<input role="combobox">`
  whose suggestions only exist once something is typed; it was opened, found
  empty, and left. A place question in a type-to-search box is now typed into
  and completed from its own suggestions, whatever role it carries — including
  a list drawn elsewhere on the page with no link back to the box.
- **A list of countries was never answered.** Only a suggestion naming the
  applicant's city was accepted, and some boxes only list countries (typing
  "uni" offers United States, United Kingdom, United Arab Emirates, Tanzania,
  US Virgin Islands). When the city searches find nothing, the state and then
  the country are searched, and only the row that *is* that place is picked —
  "United States", never "US Virgin Islands" or "…Minor Outlying Islands".

### Workday Create Account: passwords in Pending

- **The saved password, filled by Appli-Fill, was listed as two manual edits** —
  "Password" and "Verify New Password", with the password in clear text. The
  boxes were written directly, skipping the bookkeeping that marks a value as
  Appli-Fill's, so having clicked into the box beforehand made it "yours". They're
  now written like every other answer and never offered back.
- A password you type yourself is held once, as "Password"; the verify box is
  never held on its own.
- Passwords are masked in the popup's Pending list and on the dashboard's
  Saved answers page.
- **"Error: Please check the box to continue"**: Create Account was pressed
  before the required "I consent" box was ticked. Appli-Fill now leaves the form
  for you when a consent box is still clear, and the popup says so.

### Workday Voluntary Disclosures: ethnicity not ticked

The race rule steps aside for the separate "Are you Hispanic or Latino?"
question, and told the two apart with a pattern — `ethnicit\b` — that can
never match the word "ethnicity". Every option on uchicago's list reads "Asian
(Not Hispanic/Latino) (United States of America)", so the whole list was taken
for the Hispanic question and refused. Fixed, and "(Not Hispanic/Latino)" is
now read as the qualifier it is, like "(Not Hispanic or Latino)". Your
ethnicity's box is ticked and only that one; a category the list doesn't offer
("Two or More Races") ticks nothing.

---

## 1.17.0 — Application questions answered, one fast AI call, "." for a missing location, Overview layout

Every change below is covered by a test; the suite is now **1073 checks, all
passing** (`npm test`). Two new spec files, each confirmed to fail against
1.16.0: `app-questions-rules` (the rules on their own) and
`workday-app-questions` (19/53 passed on 1.16.0). New fixture:
`test/fixtures/workday-app-questions.html` — a Workday Application Questions
step with sixteen menu questions, a radio group, a checkbox list and free text.

### Workday application questions not filling

On the test page 1.16.0 left five questions blank, answered three wrongly, and
made twelve AI requests taking about 17 seconds at a realistic model speed.
1.17.0 answers every question except the one only the applicant may answer
(a felony question), with **one** AI request, in about 5 seconds.

| Cause | Fix |
|---|---|
| **AI answers were effectively off.** The setting defaulted to off, and turning it on in the popup never saved: the settings API ignored the popup's sign-in token, so the next sync switched it back. | On by default for everyone who hasn't chosen otherwise (still Premium, trial included). The popup's switch now saves. Drafted answers are highlighted for you to review. |
| **Menus reached the model with no options — or another menu's.** The AI pass opened four Workday menus at once to read their choices; Workday shows one menu at a time, so most came back empty (the education question was sent the years-of-experience options) and the answers matched nothing. | Menus are read one at a time, before anything is asked. |
| **One request per question.** Ten questions, ten round trips, and the hourly allowance went quickly. | One request for the whole page, sent the moment planning ends — the model works while the form fills, and its answers go into whatever is still blank. An older server is still asked one question at a time. |
| Workday's sponsorship wording — "require the company to sponsor an immigration case" — matched no rule. | Recognised, answered from the profile (including "…without sponsorship" the other way round). |

### Faster start with more than one profile

Premium accounts with several profiles waited on a model call to pick the
best profile before anything was filled — on every step of a Workday
application, for up to 15 seconds when the service was slow. The profile is now
chosen once per job, never waited on for more than 4 seconds (your active
profile is used meanwhile), and reused on every later step, so one application
is never filled from two profiles.

### Answered wrongly

- **"Do you have any relatives currently employed by Leidos?" → Yes.** The "I currently work here" row checkbox rule claimed it (and "Are you currently employed?", answered **No** for someone with a current job). That rule now only takes the row's own checkbox; "Are you currently employed?" is answered from the work history.
- **"Have you previously been employed by Leidos?" → No**, with Leidos on the work history. The profile holds one "worked here before" answer for every employer. Now the employer the question names — or the company in the address (Workday's tenant, e.g. `leidos.wd5…`) — is looked up in your experience: "Leidos, Inc.", "GDIT" for General Dynamics Information Technology, "boozallen" for Booz Allen Hamilton. A match is "Yes" (current or former); anything else falls back to your stored answer.
- **"Have you ever worked with Kubernetes?" → No.** Matched the prior-employment rule on "ever worked". That rule now needs an employer in the question.

### Now answered from what the profile already says

- **Federal government service** — civilian agencies, GS grades, and military service when the question includes it ("military or civilian"). Shown as a draft to check.
- **Able to obtain a clearance** — Yes for a U.S. citizen, No for a non-citizen (it was left blank for everyone without one).
- **Highest level of education** — across every school on the profile; only finished degrees when the question says "completed". It used to offer "Master of Science" to a menu of levels and match nothing.
- **Years of experience** — the whole career (overlaps counted once) for the plain question; only the roles whose title names it for "years of DevOps / cloud engineering experience" (or whose description does, for a skill you list); left to the model for "relevant". Range menus ("6-10 years", "More than 10 years") are now matched.

### Saved answers from another employer

Portals reuse the same questionnaire with the company swapped in. "Do you have
any relatives currently employed by GDIT?" → "No" now answers "…by Leidos?" —
only as a choice, never an answer that names the other company, and never ahead
of your profile.

### What the AI is and isn't asked

It gets your profile (now including citizenship, clearance, licence and total
years), your saved answers that bear on the page (never passwords), the job and
all the open questions. It works facts out from your history but never invents
them; answers willingness questions (travel, on-site, essential functions)
"Yes" unless your profile says otherwise; and leaves blank what it would have to
guess. Criminal record, dismissals, health, religion and the like are never sent
— your saved answer to the exact question is used, or the question waits for
you. Consents and certifications are left for you.

### Work Experience: "." when a job has no location

A job on your profile with no location now fills Location with "." on Workday
(required or not). This had never worked: the rule table loaded before the
matcher and read it as empty, which also disabled the two-letter state code.
Both fixed.

### Dashboard: "Connect the extension" and "Profile strength" cut off

One long company name in Recent applications widened the page's main column and
pushed the right-hand cards past the window, behind a horizontal scrollbar. Every
dashboard column can now shrink; long names are truncated with the full text on
hover. The cards sit beside the main column from 1180px and stack underneath on
smaller screens, at every width from 390px up. Once a browser is paired, "Connect
the extension" becomes a short "Extension connected" card. The activity chart
has a legend and a summary (last 7 days, best day, active days, streak).

### Upgrading

- Answers held in Pending by earlier builds can be discarded from the popup.
- AI answers need Premium (the trial counts) and `GEMINI_API_KEY` (or
  `GROQ_API_KEY`) on the server. The answer route now allows 30 seconds
  (`maxDuration`) and answers within 20.

---

## 1.16.0 — Lever phone and location, Pending shows only your edits, Workday self-identify

Every change below is covered by a test; the suite is now **926 checks, all
passing** (`npm test`). Three new spec files, each confirmed to fail against
1.15.0: `lever-location` (4/22 passed on 1.15.0), `workday-selfid` (22/33) and
`provenance` (7/13). New fixtures: `test/fixtures/lever-location.html` (Lever's
application page as served, `data-qa` on the wrappers, a location box that only
accepts one of its own suggestions), `workday-selfid.html` (Voluntary
Disclosures + CC-305 with generated ids), `workday-selfid-step.html` (a current
tenant's Self Identify step) and `provenance.html` (a page that reformats,
wipes and re-renders answers after a fill).

### Lever: Phone read "516-205-8456Jacksonville, Florida, United States…"

| Cause | Fix |
|---|---|
| The field scan also looks at anything carrying `data-qa`/`data-testid`. Lever puts those on the `<li>` and `<div>` **around** each question too, so every wrapper was collected as a text box. "Typing" at a `<div>` goes to whichever box has the caret — the Phone box the applicant had just checked — so the location (and name, and company) were appended to the phone number. | Only real controls are collected: inputs, selects, textareas, buttons, ARIA widgets and rich-text hosts — never their wrappers. |
| Text is typed with `execCommand("insertText")`, which writes into *whatever is focused*, not into the element it was meant for. | The command is only used once focus is confirmed to be on the box being written (through shadow roots too). Otherwise the value is set on that box directly, so nothing can ever land in a different field. The same guard covers the Workday date segments, where a widget that moves the caret on by itself could send a digit into the next segment. |
| Each Lever wrapper `<li>` has a `value` property (its list number), so "Full name", "Current location" and "Current company" were held in Pending Saved Answers as **"0"**. | Wrappers are never collected, the background refuses these entries, and updating to 1.16.0 clears the ones already held. |

### Lever: Current location sat with its list open, nothing picked

Lever's "Current location" only counts a place picked from its own suggestions
(that click fills the hidden `selectedLocation` the form submits). Appli-Fill now
finishes a type-to-search place box: it waits for the list, picks the suggestion
that is the applicant's city in the applicant's state ("City of Jacksonville,
FL, USA" for Jacksonville, Florida — never "Jacksonville Beach" or
"Jacksonville, NC"), and narrows the search ("Jacksonville, FL", then
"Jacksonville") if the full answer finds nothing. If no suggestion is the
applicant's place, the typed answer stays and the box is outlined for them. A
box that shows no list is left exactly as typed. Also works with Google Places
boxes.

### Pending Saved Answers showed values the extension filled

The test for "the applicant changed this" was page-wide: any real click or key
**anywhere on the page** in the previous eight seconds. A click on the page (or
the in-page Fill button) followed by the page doing something to a value Appli-Fill
had written — a phone mask, a thousands separator on the salary, a date
rewritten as 2026-10-01, a re-rendered control — offered Appli-Fill's own answers
back as manual edits. The settle/repair passes also re-typed values as
"nobody", so a restored field looked hand-edited.

Now a change is the applicant's only when **that control** (or its group, or
the menu it opened, or the calendar beside it) got a real pointer, key, paste,
drop or typing **after Appli-Fill last wrote to it**. What the page does to
Appli-Fill's answer afterwards is remembered as Appli-Fill's answer; a value that means
the same thing (a reformatted phone, salary or date, "FL" for "Florida") is
never an edit; the repair passes write as Appli-Fill. Putting Appli-Fill's answer back
withdraws what was held for the detour. Everything you change by hand — typed,
picked from a dropdown or a native select, a radio, a checkbox — is still held,
as before. Side effect fixed on the way: a field the page wiped while loading is
restored again (it was being treated as cleared by you).

### Workday: Self Identify fields not filled, including today's date

- **The form wasn't recognised.** The step is titled "Self Identify" and the
  form's name ("Voluntary Self-Identification of Disability · Form CC-305 · OMB
  1250-0005") is rich text above the fields, so the self-ID rules never applied.
  The form's printed markers above the fields now count, as do Workday's
  `selfIdentifiedDisabilityData--…` ids.
- **Date (MM/DD/YYYY)** is three boxes labelled only Month, Day and Year; the
  word "Date" hangs on the widget or on the month box alone. The widget's own
  label is now read, and each box gets its own part of **today's date** (MM,
  DD, YYYY) — a single date box still gets `MM/DD/YYYY`, a native date input
  `YYYY-MM-DD`. A calendar button beside the boxes is never opened.
- **Disability boxes** carry generated ids and no shared `name`, so each was
  treated as a lone "I agree" box and "No, I don't have a disability" ticked
  nothing. They're now answered as one question — native or `role="checkbox"` —
  and a bare "Yes"/"No" in the profile works too.
- **Ethnicity drawn as a list of boxes** (Workday's multi-select) is answered
  the same way: only the applicant's box is ticked.
- Name gets the applicant's name; Employee ID stays blank; gender, race and
  veteran status continue to come from the profile.

### Lever custom questions

A Yes/No question drawn as radio cards sits one level further out than the
label walk reached, so "Are you legally authorized to work…" was never read and
went unanswered; choice groups now look further out and skip their own option
labels. A `data-qa` value like "why-input" is no longer taken as a question's
wording in Pending.

---

## 1.15.0 — Workday State, wrong answers, pending edits, résumé, speed

Every change below is covered by a test; the suite is now **846 checks, all
passing** (`npm test`). Five new spec files, each confirmed to fail against
1.14.0: `workday-questions`, `workday-capture`, `canonical-choices`,
`pending-edit`, `popup-pending`. The new fixture
`test/fixtures/workday-questions.html` reproduces a GDIT Workday application
(current Workday markup: `address--countryRegion`, rich-text question labels,
`aria-label="… Select One Required"`, a portalled listbox, a "Select files"
upload).

### State showed the wrong value on Workday

| Cause | Fix |
|---|---|
| Workday's State menu is `id="address--countryRegion"`. The state rule refused anything whose *machine name* read "country region", so the **country** rule took the box and offered "United States" to a menu of states — where it is a prefix of **"United States Minor Outlying Islands"**, which was selected. | The Country/Region denial now reads only the label printed on the page; a box printed "State" is denied to the country rule. |
| A profile state of "MA", "GA", "VA", "IA" was matched by letters: Maine, Michigan, Nevada, California. | Every US state/territory, Canadian province and Indian/Australian state reduces to one id (`US-NC` for "NC", "N.C.", "North Carolina", "Stanley, NC"). A menu of places is matched on that id only — the right state or none. Works for saved answers too ("TX" → Texas), and a 2-character box gets the postal code. |

### Application questions answered wrongly or the opposite way

- **Yes/No menus only take a yes or a no.** "North Carolina" and "None" both began with "No", so a state or clearance level became a confident "No". Prefix/contains scoring now respects word boundaries everywhere ("No" is not in "None of the above").
- **Keyword rules no longer answer questions they don't ask.** "Have you ever *failed* a drug test?" was answered with willingness to take one — **Yes**. "Employed by the Federal Government?" was answered as "worked here before". "Please *state* your salary" got the state. "Travel out of *state*" got the state. "Able to *obtain* a clearance?" got "No". "Under 18"/"18 months" matched the age rule.
- **Your own saved answer to the exact question now wins** over a keyword rule (it was ignored on "profile-only" rules). A merely similar saved answer never beats the profile, and is refused if one question is negated and the other isn't.
- **Section headings are never questions.** A saved answer filed under "Application Questions" or "Address" matched every field under that heading.
- Security clearance answers in the shape asked (level, yes/no, or "able to obtain"); new "Are you a U.S. citizen / U.S. person?" rule from the work-authorization type.
- Eligibility questions the profile can't answer are highlighted for you (they were silently skipped) and never sent to the AI.
- AI route: "I do not know" no longer snaps to the option "No".

### Manual edits not showing in Pending saved answers

- Answers to questions that merely contained a place word ("out of state") were refused as address fields — now held.
- An answer refused once while Workday still flagged the field invalid was marked "captured" and never retried — now retried when the flag clears.
- Typed answers are captured when typing pauses, and on window blur (opening the popup), not only on field blur.
- A control Workday re-renders keeps its "before" value, so the change is still seen.
- A dismissal no longer swallows a later, deliberate edit of the same answer.
- Popup: the pending list opens by itself when there are edits, updates live while open, every entry has **Edit** (question + answer, with the question's own choices as a menu), and **Add answer** saves a typed answer straight to the dashboard.

### Résumé upload left empty

Workday's "Select files" button (`data-automation-id="select-files"`) was collected as a dropdown — outlined as "needs you" and clickable by the AI pass, which opens the file chooser. Upload controls are no longer collected, clicked or written by any path. The "Attach my resume automatically" switch is retired (popup and dashboard).

### Speed

The dashboard's 120 ms "delay" was spent after **every** field, dropdowns included; dropdowns also waited on fixed timers and an Enter-key fallback; and the page was re-scanned every 1.5 s during the fill. Now: a ≤30 ms pause for typed boxes only, dropdowns finish as soon as the value is taken, no re-scans while filling, cached question/label work. The GDIT fixture fills in **~0.7 s instead of ~5.2 s**.

---

## 1.14.0

Every change below is covered by a test; the suite was
**557 checks across 33 spec files, all passing** (`npm test`).

---

## 1. The bug that was breaking fills across portals

**A saved answer was being written into fields it had nothing to do with.**

`questionHeadingNear()` decides which printed question a control belongs to. It
walked up from the control and accepted *any* acceptable text found inside the
ancestor it was scanning. One level above a field's own wrapper, that ancestor
is usually the form itself — so every field in the form inherited the first
heading in it that ended in a question mark.

On a Workday "My Information" page whose sections are bare `<h3>`s, that heading
is **"How Did You Hear About Us?"**. The saved answer to it — `LinkedIn` — was
written into **City**. It was also offered to the **Country** and **State**
dropdowns, where it matched no option, so both were left blank and the applicant
saw three wrong or missing fields on a page that reported a successful fill.

The heading search now requires the text to be printed *above* the control with
no other control between them. Anything past the next control belongs to that
control.

> `extension/content/autofill.js` — `questionHeadingNear()`
> Covered by `test/portals/workday.spec.mjs`.

This single fix also restored the Country and State dropdowns on Workday: they
were never broken, they were being fed the wrong value.

---

## 2. Field-matching fixes

| Symptom | Cause | Fix |
|---|---|---|
| **Country left blank** on SAP SuccessFactors, Oracle HCM and some Workday tenants | The `state` rule matches `region`, so it claimed the **"Country/Region"** box. The applicant's state was then offered to a menu of countries and matched nothing. | `"Country/Region"` (and `"Region/Country"`, `"Country or Region"`) is matched as a unit and denied to the state rule. |
| **Phone number missing** on Taleo, Oracle and SuccessFactors | Those portals label the box "Primary Number", "Contact Number", "Day Time Number" — none contains the word *phone*, so no rule matched. | The phone rule now matches the qualifier-plus-number forms as well. |
| **Apartment number submitted twice** on every portal with a two-line address (iCIMS, Workday, Oracle, SuccessFactors, most in-house forms) | The street value was always composed from `address` + `addressLine2`, so Line 1 read "1703 High Point Terrace, Apt 4B" while Line 2 read "Apt 4B". | Line 1 carries the apartment only when the form has no Line 2 box of its own. A single-box form (Taleo) still gets the full street. |
| **"Source" dropdown left for the AI**, and often required | `howDidYouHear` only matched the spelled-out phrasings. iCIMS and SuccessFactors label it "Source"; Oracle "Referral Source"; Taleo "Recruiting Source". | Those forms are matched, with a denial so a free-text box called "Source" is not mistaken for the question. |

> `extension/lib/field-map.js`

---

## 3. AI answers

**The model was being sent the wrong text.** `field.label` is a derivation aid,
not a question: it is every source of text about a control joined with `" | "` —
visible label, placeholder, `data-automation-id`, the autocomplete token, the
section heading, and the humanized `name` and `id`. The answer route was
receiving, verbatim:

```
Why are you interested in joining Orbit? | A few sentences is plenty | custom question b17c | ai why
```

That cost three things at once:

1. The model was shown placeholder chatter and machine names as part of the question.
2. The route's identity guard ran over the blob, so a harmless question sitting inside a section headed "Voluntary Self-Identification" was refused on its neighbours' words.
3. The route normalizes the question to look up **what you have answered before** — and a blob normalizes to nothing any stored key matches, so the saved-answer memory never fired for a drafted answer.

The AI pass now sends `primaryQuestion()` — the same resolution the capture path
already uses, so a question drafted now and the same question banked later agree
on their wording.

Also on the route (`src/app/api/ai/answer/route.ts`):

- **Regex injection / silent failure.** The memory lookup built a MongoDB `$regex` from the question's own words, unescaped. A question containing `(`, `*` or `[` produced an invalid expression, the lookup threw, and the catch turned it into "this applicant has never answered anything" — so the memory silently stopped working on exactly the portals whose questions carry punctuation. Words are now escaped.
- **Correct answers were being thrown away.** A single-choice reply had to be byte-identical to a menu option. `"yes"`, `"Yes."`, `"I dont wish to answer"` and `I would answer "No" to this.` were all discarded and the field reported as needing the applicant. `snapToOption()` now recognises those — and still refuses anything that names two options or none, so a wrong choice is never submitted.
- The multi-select path got the same treatment, and de-duplicates its result.

The Premium gate is unchanged.

> Covered by `test/portals/ai.spec.mjs` and `test/answer-route.spec.mjs`.

---

## 4. ATS adapter table

- Removed a **dead duplicate** adapter (`successfactors` could never be reached — `sapSuccessFactors` above it has an identical test).
- **Ashby** matched any page carrying an `ashby` class anywhere, a blog post about Ashby included. It now has to be a form.
- **Oracle** claimed every page on `oracle.com`, including the marketing site, before the more specific adapters below it were tried. It is now matched on the recruiting paths and the `*.fa.*.oraclecloud.com` hosts.

> `extension/lib/ats.js`

---

## 5. Test coverage that did not exist

The suite was green when this started — the failures above were all in paths
nothing tested. Added `test/portals/`: a shared harness plus a faithful fixture
per ATS, each asserting the values that actually land in the form.

```
npm run test:portals
```

| Suite | Checks | What it holds |
|---|---|---|
| Greenhouse | 18 | react-select widgets, a board search box that must be left alone |
| Lever | 14 | label-wrapped inputs, radio cards |
| Ashby | 11 | uuid field names, question text in a div above styled radios |
| Workable | 15 | fieldset/legend questions, a multi-select left for the applicant |
| SmartRecruiters | 12 | floating labels rendered *after* their input |
| Workday | 16 | button dropdowns opening a listbox at the end of `<body>` |
| iCIMS | 24 | numbered "(1)"/"(2)" experience blocks, separate address lines |
| Taleo | 18 | table layout, machine ids, labels in a sibling cell |
| SAP SuccessFactors | 12 | question text in an `aria-describedby` node |
| Oracle HCM | 25 | four address lines and a row of boxes that must stay blank |
| Generic careers page | 14 | no adapter, with decoy search and newsletter forms above the real one |
| AI answers | 9 | what goes over the wire, and what is done with the reply |

The generic suite is the one worth knowing about: a company's own careers page
with a site-search form and a newsletter form ahead of the application form in
the document. Neither decoy gets touched.

---

## 6. Extension popup, rebuilt

- **Pairing view**: the three steps, numbered, in the order they happen. It was previously a paragraph and an input with a lot of empty space below.
- **Fill result**: a proportional bar and a key — *18 filled · 3 drafted · 2 need you*. Two of those three numbers were already being computed and only the first reached the popup, so the two an applicant has to act on were invisible.
- **Settings**: collapsed into one panel, grouped, and every switch now carries a line saying what it does. "Replace answers already in the form" reads harmless until it has overwritten something a portal filled in correctly.
- The Workday password paragraph became a labelled switch under a "Sign-in pages" heading.
- Popup widened 360 → 384px.

`node scripts/shoot-popup.mjs` renders both states to `screenshots/`.

---

## 7. Web app

**Settings** — the first two rows on the page were a *retired* setting and an
*unbuilt* one, both disabled. They are now at the bottom under "Settings that no
longer apply", and the seven live switches are grouped by the question they
answer: where answers come from, what Appli-Fill may change, what shows on the page.
The save indicator moved next to the title, where the change happens.

**Overview** — a new account saw four zeroed stat cards, an empty twelve-week
grid, a pipeline of five zero-width bars and an empty list: seven pieces of
furniture, none of which said what to do. Before the first application, those
are replaced by three setup steps that tick off as they are completed.

**Saved answers** — the *Add answer* button was pinned to the baseline of a
description that wraps, so it floated in the middle of the paragraph. Fixed
there and on Applications and Profile. The empty state has an icon, an
explanation and an action; the search box is hidden when there is nothing to
search.

**Profile** — nine sections, most of a screen each, and the only Save button was
at the top: filling in Work history meant scrolling back up to commit it. The
header is now sticky.

**Mobile** — the landing page scrolled sideways on every phone width (95px of
overflow at 360px). Grid children default to `min-width: auto` and so refuse to
shrink below their content, which stopped `truncate` from ever truncating.
Verified: no horizontal overflow on any page at 320 / 360 / 390 / 414 / 768 /
1024 / 1440px.

---

## 8. Housekeeping

- `dbg-cur.mjs` and `dbg-shapes.mjs` left the project root for `scripts/debug/`, with a README and their hardcoded `/home/claude/applifill` paths made relative.
- `npm test` now runs the portal suite too.
- `dist/chrome` and `dist/firefox` rebuilt at 1.14.0 and re-verified against the portal suite — the packaged output is tested, not just the source.

---

## Running it

```bash
npm install
npm run dev            # http://localhost:3000
npm test               # 557 checks
npm run test:portals   # the per-ATS suites alone
```

Load `dist/chrome` at `chrome://extensions` → Developer mode → Load unpacked.
The packaged build points at `http://localhost:3000`; rebuild with
`APPLI_FILL_API_BASE="https://your-domain" npm run ext:build` before deploying.

The Playwright specs need a Chromium binary. If it is not on the default path,
set `CHROMIUM_PATH`.
