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

function schemaValidate(filePath, content) {
    const usesLvgl = /\blvgl\.[a-z_]+\s*:/i.test(content);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esphome-designer-verify-'));
    try {
        const recipePath = path.join(tmpDir, 'recipe.yaml');
        const lambdaBody = usesLvgl
            ? content // leave as-is; lvgl-conditional profiles are reported, not schema-checked
            : content.replace(new RegExp(`#\\s*${LAMBDA_PLACEHOLDER}`), 'lambda: |-\n      it.fill(Color(0, 0, 0));');
        fs.writeFileSync(recipePath, lambdaBody);

        if (usesLvgl) {
            return { status: 'lvgl-conditional', detail: 'profile references lvgl.* actions; needs a manual esphome config pass using the real Designer-generated YAML (lambda + lvgl cannot both be validated generically)' };
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
${COMPANION_GLOBALS_AND_SCRIPT}
packages:
  hardware_profile: !include recipe.yaml
`;
        fs.writeFileSync(harnessPath, harness);

        const result = spawnSync('esphome', ['config', harnessPath], { cwd: tmpDir, encoding: 'utf8' });
        const ok = result.status === 0;
        return {
            status: ok ? 'pass' : 'fail',
            detail: ok ? null : (result.stdout || result.stderr || '').split('\n').filter(Boolean).slice(0, 20).join('\n')
        };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

function main() {
    const args = process.argv.slice(2);
    const wantSchema = args.includes('--schema');
    const only = args.find((a) => !a.startsWith('--'));

    const profiles = only ? [path.join(HARDWARE_DIR, only)] : listProfiles();
    const skipSchema = wantSchema && !esphomeAvailable();
    if (wantSchema && skipSchema) {
        console.warn('esphome CLI not found on PATH; skipping Tier 2 schema validation (install with `pip install esphome`).');
    }

    let hadIssues = false;
    let lvglConditionalCount = 0;

    for (const filePath of profiles) {
        const name = path.basename(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const { issues, warnings } = staticLint(filePath, content);

        let schemaResult = null;
        if (wantSchema && !skipSchema) {
            schemaResult = schemaValidate(filePath, content);
        }

        const failed = issues.length > 0 || (schemaResult && schemaResult.status === 'fail');
        if (failed) hadIssues = true;
        if (schemaResult && schemaResult.status === 'lvgl-conditional') lvglConditionalCount += 1;

        const marker = failed ? 'FAIL' : issues.length === 0 && warnings.length === 0 && (!schemaResult || schemaResult.status === 'pass') ? 'OK  ' : 'WARN';
        console.log(`[${marker}] ${rel(filePath)}`);
        issues.forEach((m) => console.log(`         issue:   ${m}`));
        warnings.forEach((m) => console.log(`         warning: ${m}`));
        if (schemaResult) {
            if (schemaResult.status === 'pass') {
                console.log('         schema:  esphome config OK');
            } else if (schemaResult.status === 'lvgl-conditional') {
                console.log(`         schema:  SKIPPED (lvgl-conditional) - ${schemaResult.detail}`);
            } else {
                console.log('         schema:  esphome config FAILED:');
                schemaResult.detail.split('\n').forEach((l) => console.log(`                  ${l}`));
            }
        }
    }

    console.log('');
    console.log(`Checked ${profiles.length} profile(s) in ${rel(HARDWARE_DIR)}.`);
    if (lvglConditionalCount > 0) {
        console.log(`${lvglConditionalCount} profile(s) are lvgl-conditional and were not schema-validated automatically - see docs/HARDWARE_PROFILE_VERIFICATION.md.`);
    }

    if (hadIssues) {
        console.error('One or more hardware profiles failed verification.');
        process.exit(1);
    }
}

main();
