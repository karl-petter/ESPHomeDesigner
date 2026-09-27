# Hardware Profile Porting Workflow

Repeatable process for porting/adding a `frontend/hardware/*.yaml` device
profile - used for the backlog tracked in
[koosoli/ESPHomeDesigner#523](https://github.com/koosoli/ESPHomeDesigner/issues/523)
and for any new device going forward. One pass through this loop = one
sub-issue closed = one PR opened.

## Draft-until-verified policy

**Every PR from this workflow is opened (and stays) as a GitHub draft
until both of the following are true:**

1. `npm run verify:hardware:schema <file>.yaml` passes (or is
   `lvgl-conditional` and was manually checked against the real
   Designer-generated YAML - see `docs/HARDWARE_PROFILE_VERIFICATION.md`).
2. The profile has been flashed to the **real physical device** and
   confirmed working (display renders, touch/audio/etc. actually
   function) - not just schema-valid.

If a device isn't in hand, the PR stays draft and says so explicitly;
don't mark it "ready for review" on schema-validation alone. Only convert
a draft to "ready for review" (`gh pr ready <N>`) once both checks above
are done and stated in the PR body.

## Loop, per device

1. **Pick a sub-issue** under #523 (or file a new one for a new device -
   same template as #527/#528/#529).
2. **Branch**: `feat/add-support-for-<manufacturer>_<model>` (snake_case),
   off current `org/main`. If a WIP branch already exists for this device
   (created during the initial audit - see #523 for the list), continue on
   it instead of starting over.
3. **Write/rewrite the recipe** against `hardware_recipes_guide.md`'s
   current conventions:
   - No `substitutions:`/`esphome.name`/`esphome.project` block unless the
     device genuinely needs board-specific substitution variables - the
     Designer injects `name`/`friendly_name` at generation time. Compare
     against a recently-shipped profile (e.g. `sunton-esp32-2432s028R.yaml`)
     if unsure.
   - Direct pin numbers, not substitution variables, unless multiple SKUs
     of the same device need different pins.
   - Exact `# __LAMBDA_PLACEHOLDER__` marker inside the `display:` lambda
     (replaces the whole `lambda:` key, not just its body - see the script
     in step 4 for the exact substitution shape).
   - Metadata header: `# Name:`, `# Resolution: WxH`, `# Shape:`, plus
     `# TARGET DEVICE:`/setup instructions per the guide.
   - Comment out system infrastructure keys (`wifi:`, `api:`, `ota:`,
     `captive_portal:`) even though the importer auto-sanitizes them.
4. **Run the runbook**: `npm run verify:hardware:schema <file>.yaml` (see
   `docs/HARDWARE_PROFILE_VERIFICATION.md`). Fix everything it reports.
   If the device uses touch + LVGL, it will report `lvgl-conditional` -
   generate the real YAML from the Designer UI and run
   `esphome config` on that output by hand instead.
5. **Physical verification, if hardware is on hand**: flash a real build
   (`esphome compile` then `esphome upload`, or via the Designer UI export)
   and confirm the display actually renders. If the device is not in hand,
   say so explicitly in the PR and expect the `(untested)` badge until a
   maintainer or another user confirms it.
6. **Open the PR as a draft** against `main` from the fork branch
   (`gh pr create --draft`), title referencing the sub-issue (`Fixes
   koosoli/ESPHomeDesigner#NNN`), body stating exactly what was verified
   (schema-only vs. physically tested) - per the draft-until-verified
   policy above.
7. **Mark ready for review** (`gh pr ready <N>`) only once step 5's
   physical verification is done and confirmed - not before.
8. **Check off** the sub-issue's acceptance boxes and the corresponding
   line in #523/#525, then close the sub-issue once merged.

## Current backlog (as of this workflow's creation)

| Sub-issue | Device | Branch | Status |
|---|---|---|---|
| #524 | (runbook itself) | `feature/hardware-profile-verification-runbook` | PR #530, draft (not applicable - tooling, no hardware) |
| #526 | waveshare-esp32-s3-touch-lcd-7 captive-portal comment | `fix/remove-stale-captive-portal-comment` | PR #531, draft (comment-only, no functional change) |
| #527 | ESP32-C3 OLED 0.42" | `feat/add-support-for-esp32_c3_oled_042` | PR #532, draft - schema passes, **not yet re-flashed to hardware after rework** |
| #528 | Waveshare ESP32-C6 LCD 1.47" | `feat/add-support-for-waveshare_esp32_c6_lcd_147` | PR #533, draft - schema passes, **no physical device available** |
| #529 | Waveshare ESP32-C6 Touch LCD 1.69" | `feat/add-support-for-waveshare_esp32_c6_touch_lcd_169` | PR #534, draft - schema passes, device previously bench-tested but **not re-flashed after this rework** |
| #525 | regression-verify all shipped profiles | - | checklist, run after #524 merges |

## Adding a brand-new device (not in the backlog above)

Same loop. File a sub-issue under #523 using the #529 template (device
name, "no prior PR", branch name, acceptance checklist), branch, then start
at step 3.
