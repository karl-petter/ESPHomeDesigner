#!/usr/bin/env node

/**
 * Hardware profile verification runbook.
 *
 * There is no existing automated protocol that checks whether a
 * `frontend/hardware/*.yaml` recipe is actually accepted by ESPHome. The
 * only prior coverage is a handful of hand-written Vitest cases that import
 * specific profiles and assert on parsed metadata (see
 * `frontend/tests/io/hardware_profile_sources.test.js`); they do not catch
 * YAML/schema errors, pin conflicts, or missing components.
 *
 * This script adds two checks, run per-profile:
 *
 *   Tier 1 (static lint, always runs, no external deps):
 *     - file parses as valid YAML
 *     - contains the exact `__LAMBDA_PLACEHOLDER__` marker required by
 *       `hardware_import.js` before the Designer will accept an upload
 *     - recommended metadata header present (`# Name:`/`# TARGET DEVICE:`,
 *       `# Resolution:`, `# Shape:`) per `hardware_recipes_guide.md`
 *     - warns if system keys (`wifi:`, `api:`, `ota:`, `captive_portal:`)
 *       are left active (uncommented) at column 0, which the guide says to
 *       avoid even though the importer auto-sanitizes them
 *
 *   Tier 2 (schema validation, requires the `esphome` CLI on PATH):
 *     - builds a throwaway device config that pulls the profile in via
 *       ESPHome's native `packages: !include` mechanism (the same
 *       deep-merge ESPHome itself uses for `esphome:`/`esp32:`/etc. -
 *       confirmed empirically: naive concatenation produces a
 *       "Duplicate key" error, `packages:` does not), replaces
 *       `__LAMBDA_PLACEHOLDER__` with a trivial `lambda: |-` body, and adds
 *       the small set of globals/script/time entities that every
 *       Designer-generated sketch injects (`display_page`, `ha_time`,
 *       `manage_run_and_sleep`, `change_page_to`) so `on_boot:` hooks and
 *       Direct-Mode page-navigation buttons in the profile resolve.
 *     - runs `esphome config <generated>.yaml` (schema/pin validation only,
 *       no compiler/toolchain download) and reports pass/fail.
 *
 * Known limitation (flag in review, do not silently pass): profiles whose
 * `touchscreen:`/other blocks call `lvgl.*` actions (e.g.
 * `sunton-esp32-2432s028R.yaml`) assume the Designer will also inject an
 * `lvgl:` component bound to the display - but ESPHome rejects a display
 * that has both `lambda:` and `lvgl:` on it. Reproducing the app's real
 * lambda-vs-LVGL rendering-mode selection is out of scope for a static
 * script; Tier 2 will report these as "lvgl-conditional" instead of
 * pass/fail and they need a manual `esphome config` pass using the actual
 * app-generated YAML (Designer -> Generate YAML) before merging.
 *
 * Tier 3 (full compile) is intentionally NOT automated here: `esphome
 * compile` downloads a full PlatformIO toolchain per board family and can
 * take several minutes per profile on first run. Run it by hand, see
 * docs/HARDWARE_PROFILE_VERIFICATION.md.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const HARDWARE_DIR = path.join(ROOT, 'custom_components', 'esphome_designer', 'frontend', 'hardware');

const LAMBDA_PLACEHOLDER = '__LAMBDA_PLACEHOLDER__';
const ACTIVE_SYSTEM_KEY_RE = /^(wifi|api|ota|captive_portal):/m;

// ESPHome's own YAML loader understands several custom tags (!lambda,
// !secret, !include, !extend, !remove, !force) that js-yaml does not know
// about by default. Without these, js-yaml raises a false-positive
// "unknown tag" error on perfectly valid ESPHome YAML (e.g.
// `level: !lambda "return x / 100.0;"`).
const ESPHOME_YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend(
    ['!lambda', '!secret', '!include', '!extend', '!remove', '!force'].map(
        (tag) => new yaml.Type(tag, { kind: 'scalar', construct: (data) => data })
    )
);

const COMPANION_GLOBALS_AND_SCRIPT = `
time:
  - platform: homeassistant
    id: ha_time

globals:
  - id: display_page
    type: int
    restore_value: true
    initial_value: '0'
  - id: page_refresh_default_s
    type: int
    restore_value: true
    initial_value: '600'
  - id: page_refresh_current_s
    type: int
    restore_value: false
    initial_value: '60'

script:
  - id: manage_run_and_sleep
    mode: restart
    then:
      - lambda: 'return;'
  - id: change_page_to
    parameters:
      target_page: int
    then:
      - lambda: 'id(display_page) = target_page;'
`;

function rel(filePath) {
    return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function listProfiles() {
    return fs
        .readdirSync(HARDWARE_DIR)
        .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
        .sort()
        .map((name) => path.join(HARDWARE_DIR, name));
}

function staticLint(filePath, content) {
    const issues = [];
    const warnings = [];

    try {
        yaml.loadAll(content, () => {}, { schema: ESPHOME_YAML_SCHEMA });
    } catch (err) {
        issues.push(`invalid YAML: ${err.message.split('\n')[0]}`);
    }

    if (!content.includes(LAMBDA_PLACEHOLDER)) {
        issues.push(`missing "${LAMBDA_PLACEHOLDER}" marker (hardware_import.js rejects uploads without it)`);
    }

    if (!/#\s*(Name|TARGET DEVICE):/i.test(content)) {
        warnings.push('no "# Name:" / "# TARGET DEVICE:" metadata comment (see hardware_recipes_guide.md)');
    }
    if (!/#\s*Resolution:\s*\d+x\d+/i.test(content)) {
        warnings.push('no "# Resolution: WxH" metadata comment');
    }
    if (!/#\s*Shape:\s*(rect|round|circle)/i.test(content)) {
        warnings.push('no "# Shape:" metadata comment');
    }
    if (ACTIVE_SYSTEM_KEY_RE.test(content)) {
        const key = content.match(ACTIVE_SYSTEM_KEY_RE)[1];
        warnings.push(`"${key}:" is active (uncommented) at top level - guide recommends commenting out system infrastructure keys`);
    }

    return { issues, warnings };
}

function esphomeAvailable() {
    const result = spawnSync('esphome', ['version'], { stdio: 'ignore' });
    return !result.error && result.status === 0;
}

// Keys ESPHome's display schema rejects when the same display is also
// owned by an `lvgl:` component (from the exact ESPHome error text:
// "Using lambda:, pages:, auto_clear_enabled: true, or show_test_card:
// true in display config is not compatible with LVGL" - lambda: is
// handled separately via LAMBDA_PLACEHOLDER removal). `rotation:` is a
// distinct case: ESPHome doesn't reject it outright, it tells you to move
// it - "use of 'rotation' in the display config is not compatible with
// LVGL, please set rotation in the LVGL config instead" - so that one is
// relocated into the lvgl: stub rather than dropped.
const LVGL_INCOMPATIBLE_DISPLAY_KEYS = ['auto_clear_enabled', 'show_test_card', 'pages'];

function findDisplayId(content) {
    const displayBlockMatch = content.match(/^display:\n((?:[ \t].*\n?)*)/m);
    if (!displayBlockMatch) return null;
    const idMatch = displayBlockMatch[1].match(/^[ \t]*-?[ \t]*id:[ \t]*([a-zA-Z0-9_]+)/m);
    return idMatch ? idMatch[1] : null;
}

/**
 * Builds a best-effort LVGL-mode recipe for schema validation: strips the
 * `__LAMBDA_PLACEHOLDER__` line (LVGL owns rendering, no lambda on the
 * display), relocates `rotation:` into the lvgl: stub, and drops the other
 * LVGL-incompatible display keys. This is NOT the same as the real
 * Designer-generated LVGL YAML (no real pages/widgets) - it validates that
 * the profile's hardware wiring (pins, components, touch) is schema-valid
 * in LVGL mode, not that any particular sketch renders correctly.
 */
function buildLvglStubRecipe(content) {
    const displayBlockMatch = content.match(/^display:\n((?:[ \t].*\n?)*)/m);
    if (!displayBlockMatch) return null;

    let block = displayBlockMatch[0];
    block = block.replace(new RegExp(`^[ \\t]*#\\s*${LAMBDA_PLACEHOLDER}\\s*\\n?`, 'm'), '');

    const lvglExtraLines = [];
    const strippedKeys = [];

    const rotationMatch = block.match(/^[ \t]*rotation:[ \t]*(\S+)[ \t]*\n/m);
    if (rotationMatch) {
        lvglExtraLines.push(`  rotation: ${rotationMatch[1]}`);
        strippedKeys.push('rotation (relocated to lvgl:)');
        block = block.replace(rotationMatch[0], '');
    }

    for (const key of LVGL_INCOMPATIBLE_DISPLAY_KEYS) {
        const keyRe = new RegExp(`^[ \\t]*${key}:.*\\n`, 'm');
        if (keyRe.test(block)) {
            strippedKeys.push(key);
            block = block.replace(keyRe, '');
        }
    }

    const recipe = content.slice(0, displayBlockMatch.index) + block + content.slice(displayBlockMatch.index + displayBlockMatch[0].length);
    return { recipe, lvglExtraLines, strippedKeys };
}

function schemaValidate(filePath, content) {
    const usesLvgl = /\blvgl\.[a-z_]+\s*:/i.test(content);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esphome-designer-verify-'));
    try {
        const recipePath = path.join(tmpDir, 'recipe.yaml');
        let lvglBlock = '';
        let lvglStrippedKeys = null;

        if (usesLvgl) {
            const displayId = findDisplayId(content);
            const stub = displayId ? buildLvglStubRecipe(content) : null;
            if (!displayId || !stub) {
                fs.writeFileSync(recipePath, content);
                return { status: 'lvgl-conditional', detail: `could not locate a display id/block to build an lvgl: stub; needs a manual esphome config pass using the real Designer-generated YAML` };
            }
            fs.writeFileSync(recipePath, stub.recipe);
            lvglStrippedKeys = stub.strippedKeys;
            lvglBlock = `\nlvgl:\n  displays:\n    - ${displayId}\n${stub.lvglExtraLines.join('\n')}\n`;
        } else {
            const lambdaBody = content.replace(new RegExp(`#\\s*${LAMBDA_PLACEHOLDER}`), 'lambda: |-\n      it.fill(Color(0, 0, 0));');
            fs.writeFileSync(recipePath, lambdaBody);
        }

        const harnessPath = path.join(tmpDir, 'harness.yaml');
        // Deliberately does NOT declare esp32:/esp8266:/rp2: - every recipe
        // in frontend/hardware/ supplies its own MCU platform block (board,
        // variant, framework, flash_size, ...), and ESPHome rejects
        // "Found multiple target platform blocks" / board-vs-variant
        // mismatches if the harness also declares one too.
        const harness = `substitutions:
  name: "verify_device"

esphome:
  name: \${name}
  friendly_name: "Verify Device"


wifi:
  ssid: "test"
  password: "testtest12"

logger:

api:

ota:
  - platform: esphome
${COMPANION_GLOBALS_AND_SCRIPT}${lvglBlock}
packages:
  hardware_profile: !include recipe.yaml
`;
        fs.writeFileSync(harnessPath, harness);

        const result = spawnSync('esphome', ['config', harnessPath], { cwd: tmpDir, encoding: 'utf8' });
        const ok = result.status === 0;
        const detail = ok ? null : (result.stdout || result.stderr || '').split('\n').filter(Boolean).slice(0, 20).join('\n');

        if (usesLvgl) {
            return { status: ok ? 'pass-lvgl-stub' : 'fail-lvgl-stub', strippedKeys: lvglStrippedKeys, detail };
        }
        return { status: ok ? 'pass' : 'fail', detail };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

function resolveProfileArg(p) {
    const direct = path.resolve(process.cwd(), p);
    if (fs.existsSync(direct)) return direct;
    // Only treat as a bare basename (fall back to HARDWARE_DIR) if it has
    // no path separators - a full relative path (as `git diff --name-only`
    // produces) that doesn't exist should fail loudly with its real path,
    // not get silently double-joined onto HARDWARE_DIR.
    if (!p.includes('/') && !p.includes(path.sep)) {
        return path.join(HARDWARE_DIR, p);
    }
    return direct;
}

function main() {
    const args = process.argv.slice(2);
    const wantSchema = args.includes('--schema');
    const positional = args.filter((a) => !a.startsWith('--'));

    const profiles = positional.length ? positional.map(resolveProfileArg) : listProfiles();
    const skipSchema = wantSchema && !esphomeAvailable();
    if (wantSchema && skipSchema) {
        console.warn('esphome CLI not found on PATH; skipping Tier 2 schema validation (install with `pip install esphome`).');
    }

    let hadIssues = false;
    let lvglConditionalCount = 0;
    let lvglStubCount = 0;

    for (const filePath of profiles) {
        const name = path.basename(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const { issues, warnings } = staticLint(filePath, content);

        let schemaResult = null;
        if (wantSchema && !skipSchema) {
            schemaResult = schemaValidate(filePath, content);
        }

        const schemaFailed = schemaResult && (schemaResult.status === 'fail' || schemaResult.status === 'fail-lvgl-stub');
        const failed = issues.length > 0 || schemaFailed;
        if (failed) hadIssues = true;
        if (schemaResult && schemaResult.status === 'lvgl-conditional') lvglConditionalCount += 1;
        if (schemaResult && (schemaResult.status === 'pass-lvgl-stub' || schemaResult.status === 'fail-lvgl-stub')) lvglStubCount += 1;

        const schemaOk = !schemaResult || schemaResult.status === 'pass' || schemaResult.status === 'pass-lvgl-stub';
        const marker = failed ? 'FAIL' : issues.length === 0 && warnings.length === 0 && schemaOk && (!schemaResult || schemaResult.status === 'pass') ? 'OK  ' : 'WARN';
        console.log(`[${marker}] ${rel(filePath)}`);
        issues.forEach((m) => console.log(`         issue:   ${m}`));
        warnings.forEach((m) => console.log(`         warning: ${m}`));
        if (schemaResult) {
            if (schemaResult.status === 'pass') {
                console.log('         schema:  esphome config OK');
            } else if (schemaResult.status === 'lvgl-conditional') {
                console.log(`         schema:  SKIPPED (lvgl-conditional) - ${schemaResult.detail}`);
            } else if (schemaResult.status === 'pass-lvgl-stub' || schemaResult.status === 'fail-lvgl-stub') {
                const strippedNote = schemaResult.strippedKeys && schemaResult.strippedKeys.length
                    ? ` (stripped for LVGL: ${schemaResult.strippedKeys.join(', ')})`
                    : '';
                if (schemaResult.status === 'pass-lvgl-stub') {
                    console.log(`         schema:  esphome config OK - LVGL best-effort stub, not the real Designer output${strippedNote}`);
                } else {
                    console.log(`         schema:  esphome config FAILED (LVGL best-effort stub${strippedNote}):`);
                    schemaResult.detail.split('\n').forEach((l) => console.log(`                  ${l}`));
                }
            } else {
                console.log('         schema:  esphome config FAILED:');
                schemaResult.detail.split('\n').forEach((l) => console.log(`                  ${l}`));
            }
        }
    }

    console.log('');
    console.log(`Checked ${profiles.length} profile(s) in ${rel(HARDWARE_DIR)}.`);
    if (lvglStubCount > 0) {
        console.log(`${lvglStubCount} profile(s) were schema-validated via a best-effort LVGL stub (no real pages/widgets) - see docs/HARDWARE_PROFILE_VERIFICATION.md.`);
    }
    if (lvglConditionalCount > 0) {
        console.log(`${lvglConditionalCount} profile(s) could not be stubbed at all (no display id found) and were skipped - see docs/HARDWARE_PROFILE_VERIFICATION.md.`);
    }

    if (hadIssues) {
        console.error('One or more hardware profiles failed verification.');
        process.exit(1);
    }
}

main();
