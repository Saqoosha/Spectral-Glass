# Architecture

One-pass WebGPU renderer. No mesh data, no vertex pipeline, no scene graph —
everything is an SDF in a fullscreen fragment shader.

## Frame path

```
┌──────────────────────────────────────────────────────────────────────┐
│  every RequestAnimationFrame:                                        │
│                                                                      │
│  1. resize canvas + history if needed                                │
│  2. push params → pills (hx/hy/hz/edgeR)                             │
│  3. writeFrame → uniform buffer (304 B: scalars + MAX_PILLS × 32 B) │
│  4. draw pass:                                                       │
│       fullscreen triangle → fs_main                                  │
│         per-fragment sphere-trace scene SDF                          │
│         if miss: sample photo → output, copy to history               │
│         if hit:  for λ in [380..700] / N:                            │
│                    refract → inside-trace → refract out              │
│                    sample photo at uv_λ                              │
│                    accumulate weighted by xyzToSrgb(cmf(λ))          │
│                  Fresnel-mix with cheap environment reflection       │
│                  EMA-blend with history[read]                        │
│                  write blended → swapchain (+ OETF if needed)        │
│                  write blended → history[write] (linear)             │
│  5. flip history.current                                             │
└──────────────────────────────────────────────────────────────────────┘
```

Two bind groups are pre-built at pipeline creation (one per history-read slot)
and swapped based on `history.current` — no per-frame bind group allocation.

## Module responsibilities

| Module | Owns |
|---|---|
| `src/webgpu/device.ts` | Adapter / device acquisition, canvas context config, resize, `device.lost` + `uncapturederror` handlers. |
| `src/webgpu/pipeline.ts` | Render pipeline creation with shader-compile-info surfacing; two pre-built bind groups; draw submission. |
| `src/webgpu/uniforms.ts` | `FrameParams` type + buffer writer. Module-scope `Float32Array` scratch. |
| `src/webgpu/history.ts` | Ping-pong `rgba16float` texture pair. Recreated on resize. |
| `src/photo.ts` | Picsum fetch → `ImageBitmap` → GPU texture. Gradient fallback on failure. `destroyPhoto` for the queue-drained cleanup path in `main.ts`. |
| `src/pills.ts` | Pill state (mutated by drag) + pointer-event lifecycle with a discriminated-union drag state. |
| `src/ui.ts` | Tweakpane bindings for `Params`. |
| `src/main.ts` | Wires everything, runs the RAF loop inside a `try/catch`, owns reload-race protection via `photoRevision`. |
| `src/math/{cauchy,wyman,srgb,sdfPill}.ts` | Pure functions mirrored by the WGSL of the same name. The 19 vitest tests are the reference. |
| `src/shaders/dispersion.wgsl` | Everything visible: SDF, sphere-trace, Cauchy, CIE, sRGB, Fresnel, OETF, spectral accumulation. |

## Uniform layout

Mirrors the WGSL `Frame` struct exactly (std140-ish rules):

```
offset  0  │ resolution.xy,  photoSize.xy                        (16 B)
offset 16  │ n_d, V_d, sampleCount, refractionStrength           (16 B)
offset 32  │ jitter, refractionMode, pillCount, applySrgbOetf    (16 B)
offset 48  │ pills[0..8]   each pill is:                         (32 B each)
           │   center.xyz, edgeR,   halfSize.xyz, _pad
```

Total 304 bytes. Uniform size is fixed — pills beyond `pillCount` are zeros.

## Why per-wavelength sRGB weighting?

The textbook path — accumulate `cmf(λ) * L(λ)` into XYZ, then one
`XYZ → sRGB` — collapses if `L(λ)` is a scalar derived from a photo's
luminance: you lose all chroma, and the only color left is whatever
`xyzToSrgb(sum(cmf))` produces (a slight salmon tint for a flat-white
spectrum, because the CMF sum isn't D65).

Per-wavelength weighting — `xyzToSrgb(cmf(λ)) * L_rgb(uv_λ)` — gives each
wavelength its own sRGB primary color, and preserves photo RGB in the
flat-UV case:

- Uniform input (same UV for all λ): `L * sum(lambdaRgb) / sum(lambdaRgb) = L`.
  Preserves chroma exactly.
- Varying input (different UV per λ): red-wavelength samples contribute to
  the R channel, blue to B, classic chromatic aberration.

The normalization denominator is the same per-wavelength primary-sum, which
keeps the output neutral for any `N`.

## SDF and sphere tracing

The pill is a two-stage rounded extrusion:

1. 2D **stadium** silhouette in XY: `roundedBox` shrunk by `edgeR`, then rounded
   by the shortest shrunk half-axis (so corners fully round into half-circles).
2. Extrude into Z: combine the 2D distance with `|z| - hz + edgeR` via
   `length/min/max` and subtract `edgeR` again → rounded top/bottom corners.

Camera is orthographic top-down. Sphere trace marches from `(px, px, 400)` in
`-Z` with `HIT_EPS = 0.25` and `MIN_STEP = 0.5`. Inside-trace uses `-sceneSdf`
to find the back-surface exit.

Normals come from central differences on the scene SDF — four extra SDF
evaluations per shaded pixel, cheap.

## Error handling

- `device.lost` + `uncapturederror`: logged + shown via `#fallback`.
- Shader compile errors: `getCompilationInfo()` logs all messages and throws
  on error (default WebGPU swallows these into opaque validation errors).
- Photo fetch failure: graceful fallback to a bundled gradient texture (not
  an exception).
- Render-loop exception: `try/catch` surfaces the error and stops the loop
  instead of freezing silently.
- Reload race: a monotonic `photoRevision` counter discards stale async
  results; old textures are destroyed only after `queue.onSubmittedWorkDone`.
- Typing-target hotkey filter: pointer events in Tweakpane number inputs
  don't fire `Space`/`Z`/`R`.

## Testing

Math modules are unit-tested (19 tests, all pass):

- `cauchyIor` at d-line, monotonicity, `V_d` sensitivity, 1.0 clamp.
- `cieXyz` Y-peak near 555 nm, red dominance at 650 nm, blue at 450 nm, near-zero at UV/IR.
- `xyzToLinearSrgb` D65 white, Y-only luminance-biased gray.
- `linearToGamma` identity endpoints, linear segment, power-curve segment.
- `sdfPill3d` sign, symmetry, top-face zero-crossing, rounded-edge smoothness.

Shader correctness is verified visually — no automated GPU tests.

## Performance budget

At 1080p with 4 pills covering ~20% of the screen, N = 8 wavelengths:

- Background pixels: 1 texture tap + OETF + early-out → negligible.
- Pill pixels: ~48 SDF evals (front trace + per-λ inside-trace × 8) + 8 texture
  taps + 8 Wyman+Cauchy evaluations + 1 reflection tap + 1 history tap.
- Measured well within the 16.6 ms frame budget on mid-range discrete GPUs.

`N = 16` stays 60 fps on the same hardware; `N = 32` approaches the budget.
