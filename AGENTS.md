# Project Agent Instructions

## Mandatory Visual QA Loop (All UI Work)

Follow this loop before marking any UI task as complete.

1. Run the app and validate real rendered output, not just code inspection.
2. Test at these viewport sizes at minimum:

- 1280x800 (laptop)
- 1536x960 (desktop)

3. For each viewport, check all primary regions:

- top bar/search controls
- left conversation list and cards
- conversation header chips/metadata
- token chart and labels
- timeline header/filter controls
- timeline list rows
- event detail rendered/raw panes

4. Enforce these layout invariants:

- no clipped text on visible controls
- no overlap/occlusion between siblings
- no unintended horizontal page scrolling
- no accidental double scrollbars
- wrapping/truncation must be intentional and readable

5. Run an overflow assertion in-browser after each UI change:

- detect visible elements where `scrollWidth > clientWidth` or `scrollHeight > clientHeight` unless that element is intentionally scrollable
- treat any unexpected offenders as blockers and fix before completion

6. Capture screenshots for at least one desktop and one narrow viewport and visually inspect for jank.
7. If any issue is found, fix and repeat the full loop.

## Definition of Done for UI Changes

- All required viewport checks pass.
- Overflow assertion has no unexpected offenders.
- Screenshot review shows no clipping, overlap, or obscured controls.
- Final response includes a brief summary of what was visually verified.
