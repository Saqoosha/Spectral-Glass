import { initGpu, resizeCanvas, needsSrgbOetf } from './webgpu/device';
import { createPipeline, draw, rebuildBindGroups } from './webgpu/pipeline';
import { createFrameBuffer, writeFrame } from './webgpu/uniforms';
import { loadPhoto, destroyPhoto } from './photo';
import { attachDrag, defaultPills, type Pill } from './pills';
import { defaultParams, initUi, mergeParams } from './ui';
import { createHistory, resizeHistory } from './webgpu/history';
import { loadStored, debouncedSaver } from './persistence';

function showFatal(message: string): void {
  const fb = document.getElementById('fallback');
  if (fb) {
    fb.textContent = message;
    fb.classList.add('visible');
  }
  document.getElementById('gpu')?.setAttribute('style', 'display:none');
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

async function main(): Promise<void> {
  const init = await initGpu('gpu', showFatal);
  if ('kind' in init) {
    const messages: Record<typeof init.kind, string> = {
      'no-webgpu':  "This demo needs a WebGPU-capable browser (Chrome/Edge 120+ or Safari 18+).",
      'no-adapter': 'No GPU adapter available. Try reloading or updating your GPU driver.',
      'no-context': 'Failed to create a WebGPU canvas context.',
    };
    showFatal(messages[init.kind]);
    return;
  }
  const ctx = init;

  const frameBuf = createFrameBuffer(ctx.device);
  let photoNow   = await loadPhoto(ctx.device);

  const initSize = resizeCanvas(ctx.canvas, ctx.dpr);
  let history    = createHistory(ctx.device, initSize.width, initSize.height);
  const pl       = await createPipeline(ctx, frameBuf, photoNow, history);

  const stored = loadStored();
  const params = mergeParams(defaultParams(), stored?.params ?? {});
  let pills: Pill[] = stored?.pills && stored.pills.length > 0
    ? stored.pills.map((p) => ({ ...p }))
    : defaultPills(initSize.width, initSize.height);
  let detach = attachDrag(ctx.canvas, pills, ctx.dpr);

  const saveDebounced = debouncedSaver(250);
  const persist = () => saveDebounced(params, pills);

  // Race guard: a slow photo fetch shouldn't overwrite a newer one if the user
  // clicks Reload twice quickly.
  let photoRevision = 0;
  const reloadPhoto = async () => {
    const rev = ++photoRevision;
    try {
      const next = await loadPhoto(ctx.device, Date.now());
      if (rev !== photoRevision) { destroyPhoto(next); return; }
      const old = photoNow;
      photoNow = next;
      rebuildBindGroups(ctx, pl, frameBuf, photoNow, history);
      // Hold off the destroy until pending GPU work referencing `old` has drained.
      ctx.device.queue.onSubmittedWorkDone().then(() => destroyPhoto(old));
    } catch (err) {
      console.error('[photo] reload failed:', err);
    }
  };
  initUi(params, () => { void reloadPhoto(); }, persist);

  // Persist after every drag — we don't know exactly when a drag ended, but
  // every pointer event that moves a pill is followed by a pointerup/cancel,
  // so piggyback on the global pointer flow to catch all release paths.
  const onPointerRelease = () => persist();
  ctx.canvas.addEventListener('pointerup',     onPointerRelease);
  ctx.canvas.addEventListener('pointercancel', onPointerRelease);

  let forceN3 = false;
  const onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === 'z') forceN3 = true;
    if (e.key === ' ') {
      e.preventDefault();
      detach();
      const cur = resizeCanvas(ctx.canvas, ctx.dpr);
      pills = defaultPills(cur.width, cur.height).map((p) => ({
        ...p,
        cx: Math.random() * cur.width,
        cy: Math.random() * cur.height,
      }));
      detach = attachDrag(ctx.canvas, pills, ctx.dpr);
      persist();
    }
    if (k === 'r') { void reloadPhoto(); }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === 'z') forceN3 = false;
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup',   onKeyUp);

  const applySrgbOetf = needsSrgbOetf(ctx.format);
  const startTime     = performance.now();

  const loop = () => {
    try {
      const { width, height } = resizeCanvas(ctx.canvas, ctx.dpr);
      const resized = resizeHistory(ctx.device, history, width, height);
      if (resized !== history) {
        history = resized;
        rebuildBindGroups(ctx, pl, frameBuf, photoNow, history);
      }

      for (const pill of pills) {
        pill.hx    = params.pillLen   / 2;
        pill.hy    = params.pillShort / 2;
        pill.hz    = params.pillThick / 2;
        pill.edgeR = Math.min(params.edgeR, pill.hx, pill.hy, pill.hz);
      }
      const shapeId = params.shape === 'cube'  ? 2
                    : params.shape === 'prism' ? 1
                    : 0;
      writeFrame(ctx.device, frameBuf, {
        resolution:         [width, height],
        photoSize:          [photoNow.width, photoNow.height],
        n_d:                params.n_d,
        V_d:                params.V_d,
        sampleCount:        forceN3 ? 3 : params.sampleCount,
        refractionStrength: params.refractionStrength,
        jitter:             params.temporalJitter ? Math.random() / params.sampleCount : 0,
        refractionMode:     params.refractionMode === 'exact' ? 0 : 1,
        applySrgbOetf,
        shape:              shapeId,
        time:               (performance.now() - startTime) * 0.001,
        pills,
      });

      draw(ctx, pl, history);
      history.current = history.current === 0 ? 1 : 0;
    } catch (err) {
      console.error('[frame] render loop aborted:', err);
      showFatal(`Render loop stopped: ${err instanceof Error ? err.message : String(err)}`);
      return;  // do NOT reschedule — freezing is better than a flood of identical errors
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main().catch((err) => {
  console.error(err);
  showFatal(`Couldn't start the demo: ${err instanceof Error ? err.message : String(err)}. See the browser console for details.`);
});
