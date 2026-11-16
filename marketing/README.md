# Book Marketing Studio v2.2

**Marketing** takes a book from final copy to readers worldwide, with as
much of the repeat work automated as the stores allow.

It is meant to run at **bookmarketing.amaldas.si**. It uses a simple
VPS stack: **Node.js 20+, Express, plain HTML/CSS/JS and
SQLite (sql.js)**. There is no Next.js, Postgres or Redis. Run it with
`npm install && npm start` behind Caddy.

## What's new in v2.2

- **Main admin from `.env`.** On first start, `ADMIN_USERNAME` and
  `ADMIN_PASSWORD` create the admin account (only when there are no
  accounts yet). Sign in with a username or an email.
- **Prompt library v2.** Every prompt now has five parts: role, context
  (filled in from the book's own data), task, constraints and output
  format. A list of machine-sounding phrases is banned in all copy. Older
  versions stay in Settings → AI routing & prompts, and your own edited
  prompts are never replaced.
- **Positioning first.** Reader profile and positioning (with five title
  and subtitle options). Every later piece of copy reuses them.
- **New copy:** description A/B pair, KDP's 7 keyword boxes (Amazon's rules:
  no words already in the title or categories, no misspellings, no program
  names), 3 KDP categories (one larger, one or two smaller), promo-site
  submission copy, a free reader-magnet bonus, a 30-day content plan built
  from the chapters (schedulable day by day), and social proof built only
  from real reviews.
- **Analyses from your own data:**
  - **Ad check.** Break-even ACOS = royalty per sale ÷ price. Each campaign
    gets a verdict: scale, tune, cut, or fix the listing.
  - **Competitor teardown** from the competitors you track.
  - **Portfolio briefing** on the dashboard: the whole catalogue, gaps and a
    90-day action list.
- **Lessons flywheel.** Kaizen lessons from earlier books of the same
  imprint are added to every new prompt for that imprint.
- **ARC reminders** on day 7 and day 14, then stop. Every ARC email asks
  readers to mention that they received a free advance copy.

## Publishing tracker (v2.1)

Covers every platform in the *Book Marketing* document.

- **The catalog.** 35 platforms: Amazon (KDP, Kindle Translate, KDP
  Virtual Voice, ACX), ebook stores, print (IngramSpark, Lulu), libraries
  and subscriptions, audio, direct sales, and the aggregators
  (Draft2Digital, PublishDrive). Each platform records:
  - which formats it takes;
  - the routes it can be reached by (direct, or through Draft2Digital,
    IngramSpark, PublishDrive or Voices by INaudio);
  - whether KDP Select blocks it;
  - the notes from the document.
- **One row per edition and platform**, with a status: not started →
  uploaded → in review → live / pre-order, or rejected (a reason is
  required, and it becomes a Kaizen lesson), delisted, or not applicable.
  Each row also has a date, a link, a store ID and the route used.
- **Rollout checklist from the imprint's plan.** One click builds it from
  "Recommended setup per imprint":
  - Amazon first;
  - then Apple, Kobo, Google Play and B&N direct, with Draft2Digital for
    the libraries and smaller stores;
  - IngramSpark for the manufacturing line;
  - audio once a book proves it sells (manufacturing) or straight away
    (faith);
  - Lulu and an Amazon seller account for spiral workbooks.
  Ebook items that KDP Select blocks are skipped.
- **Guards.**
  - KDP's weekly cap is counted when a title is first uploaded, because
    drafts count.
  - While the ebook is in Select, every wide ebook, library, subscription
    and direct-sale row is blocked.
  - Select can't be switched on while the ebook is out wide.
- **Reminders.** A listing that stays "uploaded" or "in review" for more
  than 7 days gets an alert and a task.
- **"Is it live?" checks.** Apple Books (Apple's book search) and Google
  Play (Google Books) are checked daily for listings that are uploaded or
  in review, and marked live when found. Other stores have no public
  lookup, so they stay manual.
- **Dashboard.** Shows, per book, what's live, pending, stuck and
  rejected, and what comes next.
- **Paid services** (BookFunnel, NetGalley, Reedsy Discovery, BookBub
  Featured Deal, Kirkus, Written Word Media) are tracked per book. Their
  cost counts in the margin and their results become lessons.
- **Pen names.**
  - Lamp & Path Press books are published as **J. A. Gauscal**.
  - Existing data is upgraded once.
  - A handoff with the wrong name raises an alert, and the compliance
    checks flag it.
  - Each imprint has its own profile checklist: LinkedIn only for the
    manufacturing line; a pen-name email, website, Facebook, Instagram
    and logo for Lamp & Path; plus StoryGraph, LibraryThing, Substack and
    Medium for both.
- **Own ISBNs.** The compliance checks flag print editions without one.

## What's new in v2

### Fixes
- **API key screen:** saving and testing keys works again. The page and
  the server used different field names.
- **Budgets:** budgets now work, including an overall monthly budget.
- **Margins:** production cost shows correctly instead of always $0.
- **Backlist check-ins:** they now become due and appear on the dashboard.
- **Stage gates:** a stage can only be approved once the stage before it
  is done or skipped.
- **Prompts:** `{imprint}`, `{title}`, `{channel}` and the other
  placeholders are now filled in.
- **Milestones:** #1, Top 10 and Top 100 are recorded per category.
- **Dashboard:** the imprint and stage filters work.
- **Pipeline:** stage names are shown.
- **Pop-ups:** browser pop-ups are replaced by forms and notices.

### Book handoff, fully used
- The handoff package is now unpacked:
  - `manuscript.txt` is saved and split into chapters.
  - The cover is saved.
- Every metadata field is kept: author, back cover, author bio, trim,
  page count, word count and series.
- A repeat handoff never wipes out a field that wasn't sent.

### Automation
A scheduler runs every minute. Each rule can be turned off in
**Settings → Automation**.

- **Launch plan:**
  - Creates an 18-step task calendar for the imprint.
  - Drafts the content kit 2 weeks before launch.
  - Schedules the **approved** posts, email sequence and LinkedIn article
    1 week before launch.
  - Can localize the store pages 5 weeks before launch.
- **Content calendar:**
  - Posts automatically to LinkedIn, the Facebook Page, Instagram, X and
    the Brevo email list.
  - Posts for channels that aren't connected go to a webhook (e.g. n8n →
    WordPress for "Own website") or appear under **Today → Posts to do by
    hand** with a copy button.
  - Only approved content can be scheduled. Placeholder drafts can't be
    approved.
- **Backlist check-ins** are analysed on their due date.
  - Approving a recommendation creates the task.
  - For description, keyword and localization fixes, it also drafts the
    first version.
- **ARC reminders** on day 7 and day 14 with no review. You choose: off, add a
  task, or send a polite email.
- **Pitch follow-ups** after 10 days.
- **Daily digest**, in the app and by email.
- **Competitors** found through Google Books are re-checked weekly.
- **Exchange rates** can be refreshed daily (ECB).
- **Token expiry:** a warning before the LinkedIn token expires.
- **Background jobs** can be scheduled for later. They retry with backoff
  and pick up where they left off.

### Selling worldwide
- **Prices for all 13 Amazon Kindle marketplaces.**
  - Local "charm" prices (prices ending in .99).
  - 70% royalty bands checked on KDP's price page on 2026-11-16 (US/CA
    $2.99–$12.99, UK £1.77–£12.99, EUR €2.69–€12.99, JP ¥250–¥1,650,
    BR, MX, AU, IN).
  - Estimated royalty per sale, in local currency and USD.
  - Print royalty: 60%/50% minus printing cost.
  - Delivery costs, VAT and the "70% needs KDP Select" markets are
    estimates. The app says so.
- **Localized store pages** for 16 languages: title, description,
  keywords and categories, written for that market rather than
  translated word for word. A named native reviewer must approve each
  one. Approved languages also show on the public book page.
- **Whole-book translation**, chapter by chapter:
  - DeepL with real glossaries, with Claude as the fallback.
  - Scripture in faith books is marked `[VERIFY SCRIPTURE]`.
  - A native reviewer must approve before publishing.
- **Whole-book AI narration** (ElevenLabs), chapter by chapter, with a
  cost estimate and budgets.
- **Amazon's own Kindle Translate and Virtual Voice (beta)** are listed as
  options. They have no API.
- **Foreign rights tracker:** territory, language, partner, status,
  advance, royalty, reversion date. Plus a rights-guide content type.
- **Money in any currency:** sales and ad spend are converted to USD for
  margins.

### Reaching readers
- **Smart link `/b/<book>`:**
  - Sends each reader to their own Amazon store (amazon.de, .co.jp …).
  - `?s=kobo` or `?s=apple-books` sends them to a specific store.
  - Clicks are counted by channel and country. Bots are ignored.
  - Every channel gets its own tracked link.
- **Public book page `/p/<book>`:**
  - Cover, description in the reader's language, buy buttons for every
    live store, endorsements.
  - Search-engine (schema.org Book) and social-sharing (OpenGraph) tags.
  - Free-first-chapter signup with **double opt-in**, one-click
    unsubscribe and a honeypot against bots. The list is synced to Brevo
    or MailerLite.
- **Content Studio:** 20 content types, any language. Includes:
  - Amazon A+ content
  - short-video scripts
  - BookBub/Meta ads
  - 60+ Amazon Ads keywords
  - back matter (also-by and signup)
  - quote cards and author bios
  - rights guide
  - media, podcast, library and bookstore pitches
- **Research:** KDP keywords, categories and comparable titles per
  marketplace, plus Amazon Ads keywords. Perplexity is used for
  live-source research.
- **Pitches (outreach tracker)** for podcasts, media, libraries and
  bookstores: draft, send from your Gmail, follow up, record the result.
- **Contacts** of every type, imported from CSV. Consent is tracked; only
  confirmed readers are exported or emailed.
- **Author platform checklist** for each imprint: Author Central in 5
  marketplaces, BookBub, Goodreads, Google Play, Apple, Kobo, IngramSpark,
  OverDrive and the website.

### Sales and analytics
- **One importer for every report:** KDP (including KENP), IngramSpark,
  Draft2Digital, Apple, Kobo, Google and Amazon/Meta Ads.
  - Accepts CSV, TSV or **XLSX**.
  - Columns are recognised by name. Rows are matched to books by ASIN,
    ISBN or title.
  - European decimals are read correctly.
  - Importing the same report again replaces it rather than doubling it.
  - Unmatched titles are listed, never guessed.
- **Charts:** royalties by month and by marketplace, rank trend per
  category, clicks by day, channel and country.
- **Dashboard figures:** month royalties, units, ad spend, net margin,
  confirmed readers, clicks and books live.
- **Ads:** ACOS, ROAS, CTR and CPC.
- **Price tests** compare equal-length periods before and after.

### Security and reliability
- **Database writes** are batched and atomic (temp file + rename), with a
  flush on shutdown. Reads never write to disk.
- **Security headers:** CSP, frame-deny, nosniff, HSTS behind HTTPS.
  Secure cookies behind Caddy.
- **No inline scripts anywhere.** Cover SVGs are served sandboxed.
- **Two-step sign-in** can only be turned off with a current code or the
  password.
- **Gmail** uses an OAuth refresh token, so access tokens refresh by
  themselves.
- **Database upgrades:** a v1 database is upgraded in place on first
  start.

## Honest limits (shown in the app)
- KDP has no sales API and no upload API.
- Amazon has no rank API.
- Kindle Translate and Virtual Voice live only inside the KDP Bookshelf.
- Goodreads and BookBub have no public API.
- Grammarly has no public API.
- **Pressing Publish on any store is always a human step.** The app
  prepares copy-ready fields and records that you published.
- X posting needs a paid X API tier.
- Instagram posts need a public image URL.
- LinkedIn tokens last about 60 days.
- Provider calls have not been tested against live API keys. Without
  keys, the app uses clearly labelled local drafts (which can't be
  approved) or a manual step.

## Run it

```bash
cp .env.example .env   # fill in ENCRYPTION_KEY, SESSION_SECRET, HANDOFF_TOKEN
npm install
npm start              # http://127.0.0.1:3001
npm test               # 232 smoke-test checks, no keys or network needed
```

On first run, open the app and create the admin account. Then:

1. **Settings → Integrations:** set the handoff token, the public base URL and the notification email.
2. **Settings → API vault:** connect Anthropic first, then Perplexity,
   DeepL, Brevo (with the sender email and list ID), Gmail and the social
   accounts.

## Files

```
server.js            Express app, auth, core routes (books, stages, listings,
                     content, contacts, ARC, sales, ranks, refresh, dashboard)
routes/growth.js     Worldwide pricing, localization, research, rights,
                     pitches, content calendar, smart-link stats, report
                     import, notifications, automation, whole-book audio and
                     translation, background job handlers
routes/rollout.js    Publishing tracker: platform catalog per edition, statuses,
                     rollout checklist, live checks, reminders, paid services
routes/public.js     /b smart link, /p book page, signup (double opt-in),
                     confirm, free chapter, unsubscribe
lib/db.js            SQLite schema, in-place upgrades, seeds, batched atomic writes
lib/ai.js            Providers, routing + fallback, budgets, usage, research,
                     images, ElevenLabs, DeepL (glossaries), email (Brevo,
                     Gmail OAuth), list sync and campaigns
lib/global.js        Marketplaces, KDP bands, FX, price ladder, royalties,
                     visitor country → store
lib/marketing.js     Stages, KDP cap, launch calendar, margins, trends,
                     milestones, refresh analysis, CSV, helpers
lib/importers.js     CSV/XLSX report importer with book matching
lib/manuscript.js    Handoff unpacking, chapter splitting, book files
lib/prompts2.js      Prompt library v2 (role, context, task, constraints, format)
lib/platforms.js     Platform catalog, imprint rollout plans, paid services, pen names
lib/livecheck.js     Apple Books / Google Play "is it live?" lookups
lib/social.js        LinkedIn, Facebook, Instagram, X, Brevo campaign, webhook
lib/scheduler.js     Automation engine (every minute)
lib/jobs.js          Background job queue (run later, progress, retry, resume)
lib/crypto.js        AES-256-GCM vault, scrypt passwords, TOTP
public/              index.html, styles.css, app.js, charts.js
scripts/smoke-test.js  232 checks
```
