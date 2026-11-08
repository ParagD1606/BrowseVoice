# Browse Voice 🎙️⚡

> **Get things done online—in a language that feels like yours.**

Websites can be hard to use when the instructions are unfamiliar, the forms are confusing, or everything assumes you are comfortable with English. Many people end up relying on someone else to do everyday things online.

**Browse Voice is a patient, conversational helper for using websites.** Tell it what you want to do by speaking or typing. It can guide you around the page, ask for details when it needs them, and help complete supported tasks one step at a time—while you stay in control.

## Who Browse Voice is for

Browse Voice is designed for people who:

- Find websites or online forms difficult to understand or navigate.
- Feel more comfortable speaking than typing.
- Prefer Hindi, Hinglish, English, or another supported Indian language.
- Want clear, step-by-step help instead of having someone else take over.

It can be useful for anyone who wants a little more guidance while using the web.

## How it helps

1. Open the Browse Voice side panel on a website.
2. Say or type what you want to do, in your preferred language.
3. Continue the conversation as Browse Voice looks at the page and guides you through it.
4. For a form, answer one question at a time. Browse Voice can convert Hindi answers to English text for supported fields.
5. Review the page yourself before submitting anything.

If something is unclear or information is missing, Browse Voice can ask a follow-up question. You can stop it at any time.

### Run independent tasks in parallel

Browse Voice can split one command into up to four independent browser tasks. Each task gets its own background tab, planner loop, activity card, and on-page “Browse Voice active” indicator. For example:

```text
open youtube in one tab and google on other tab and search animals in youtube and plants in google
```

The tasks run concurrently and Browse Voice reports one combined summary when they finish. The parallel task limit is configurable in **Settings** and defaults to three. Browse Voice keeps the current tab focused unless you enable the option to focus the first completed task tab.

Each task still uses the same safety controls: sensitive fields remain user-only, submit/payment actions require a separate confirmation, and the global **Stop** control aborts every running task.

## You stay in control

- Browse Voice asks you for the information it needs and works through tasks in visible steps.
- Passwords, one-time codes, payment card details, and other protected fields are left for you to enter yourself.
- Actions such as submitting a payment need your confirmation. Always check important details before continuing.
- Websites vary, and an AI service can misunderstand a page or an answer. Browse Voice is here to assist, not make decisions for you.

## Try the demo

The included BijliSeva electricity portal is a **sample demo for trying Browse Voice**. It is not an official utility website and does not process real payments. Use sample information only; never enter real passwords, card numbers, or one-time codes.

To run the demo locally, you will need Node.js and npm:

```bash
npm install
npm run build
npm run portal
```

Then open `chrome://extensions` in Chrome, enable **Developer mode**, choose **Load unpacked**, and select this project’s `dist` folder. Open the portal at [http://localhost:4000](http://localhost:4000), then open Browse Voice from the Chrome toolbar or side panel.

For AI planning, add a supported provider and API key in Browse Voice **Settings**. Speech features and available languages depend on your speech provider and settings. Your chosen AI and speech providers may process the page details, questions, answers, or audio needed to respond; check their privacy terms before use.

## For contributors

Browse Voice is an early-stage project. To run the existing automated checks, use:

```bash
npm test
```

The extension is built with TypeScript, React, and Chrome’s extension platform. Core areas include the side panel, page observation and actions, AI planning, speech support, and safety checks.

### Current limitations

- Some pages, browser-internal screens, CAPTCHAs, and content inside protected frames cannot be controlled automatically.
- Supported actions and language quality depend on the website and the configured AI or speech provider.
- A human should review information and confirm important actions, especially payments and submissions.
