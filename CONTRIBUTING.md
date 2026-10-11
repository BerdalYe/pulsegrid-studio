# Contributing to PulseGrid Studio

Thanks for helping. Anything from a bug report to a new feature is welcome.

## Reporting a problem

Open an [issue](https://github.com/BerdalYe/pulsegrid-studio/issues/new), or use **Help → Report a problem** in the
app, which fills in the version for you. Say what you did, what you expected and what happened instead. A project
file or a screenshot helps a lot.

## Suggesting a change

For anything bigger than a small fix, open an issue first, so we can agree on the idea before you spend time on it.

## Sending a pull request

1. Fork the repository and make a branch.
2. `npm install`, then `npm run app:dev` (desktop) or `npm run dev` (web) while you work.
3. Before you send it, run `npm run typecheck` and `npm test`. Add tests for logic you change where you can.
4. Keep the change focused, and describe what it does and how you checked it.

Some habits of the code base:

- Write code that reads like the code around it: the same naming, comment style and structure.
- Text in the app is plain and short, and says what happens, not how it's built ("Instruments", not "SoundFont presets").
- Keyboard shortcuts live in one table, `src/lib/hotkeys.ts`; the keys that play notes are off limits.
- Projects must keep opening: anything read from a project file goes through the sanitisers in `src/state/initialState.ts`.

## Licence of contributions

PulseGrid Studio is licensed under the GNU GPL, version 3 or later. By sending a contribution you agree that it is
licensed the same way.
