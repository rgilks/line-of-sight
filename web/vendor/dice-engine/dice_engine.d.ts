/* tslint:disable */
/* eslint-disable */

export class DiceRoller {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * True once the current roll has come to rest.
     */
    is_settled(): boolean;
    /**
     * Advance physics by the real time elapsed since the last frame, then draw
     * once. Stepping the fixed-rate simulation as many times as wall-clock time
     * demands (capped) keeps the dice tumbling at the same speed regardless of the
     * display rate — at one step per frame they ran in slow motion on any device
     * painting below 60 fps, which is most phones mid-roll. The step *sequence* is
     * unchanged (we never skip a step, only pace them), so the settled faces — fed
     * back as the engine's rng — stay deterministic.
     */
    render(): void;
    resize(width: number, height: number): void;
    /**
     * Throw `count` dice (1..=6).
     */
    roll(count: number): void;
    /**
     * Continuous sliding/rolling energy from the last physics step, driving the
     * scrape layer. Falls to zero once every die has come to rest.
     */
    rolling_energy(): number;
    /**
     * Collisions from the last physics step, flattened as `[kind, vel, x, z, die]`
     * per impact (stride 5); empty after read. `kind` is 0 = die-on-die,
     * 1 = die-on-floor, 2 = die-on-wall; `vel` is the approach speed along the
     * contact normal; `x`/`z` are the tray-space contact point (tray half-extent
     * 1.7); `die` is the index of the die, for per-die pitch.
     */
    take_impacts(): Float32Array;
    /**
     * The value on top of each die (meaningful once settled).
     */
    values(): Uint8Array;
}

export function create_dice_roller(canvas: HTMLCanvasElement, _count: number, bg_r: number, bg_g: number, bg_b: number, transparent: boolean): Promise<DiceRoller>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_diceroller_free: (a: number, b: number) => void;
    readonly create_dice_roller: (a: any, b: number, c: number, d: number, e: number, f: number) => any;
    readonly diceroller_is_settled: (a: number) => number;
    readonly diceroller_render: (a: number) => [number, number];
    readonly diceroller_resize: (a: number, b: number, c: number) => void;
    readonly diceroller_roll: (a: number, b: number) => void;
    readonly diceroller_rolling_energy: (a: number) => number;
    readonly diceroller_take_impacts: (a: number) => [number, number];
    readonly diceroller_values: (a: number) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h07336972953fac62: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h56c28326e79415d2: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h441d7167eb2c0b4b: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h441d7167eb2c0b4b_2: (a: number, b: number, c: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
