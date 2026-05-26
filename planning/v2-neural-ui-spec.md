# ARC Reactor v2 — Neural UI Visual Overhaul: Specification
> Version: 2.0.0-draft | Date: 2025-05-26

---

## Overview

The v2 Neural UI adds four new sphere states (listening, thinking, speaking, error), improves idle behavior, and adds visual feedback systems for voice quality and audio activity. All changes are additive — the existing Three.js architecture, Fibonacci sphere, bloom post-processing, and audio reactivity are preserved unchanged.

This document specifies every visual change with exact values and implementation steps.

---

## Current State Inventory

The existing Neural UI has:
- **Sphere**: 152-node Fibonacci layout, dual shells (inner/outer)
- **Materials**: `nodeMat` with `speak` uniform (0.0–1.0), `edgeMat`, `coreMat`
- **Bloom**: `UnrealBloomPass`, strength driven by `audioRms + audioBass`
- **Orbital rings**: 3 rings with independent rotation speeds
- **Signal pulses**: Moving highlights along edges
- **Core**: Scale driven by audio intensity
- **Waveform**: Canvas-drawn FFT visualization
- **Subtitles**: `#voice-line` element with fade timer
- **States tracked**: `curTask` (active/idle), `pulseFactor` (per-narration)

---

## New States

### State 1: LISTENING

Activated when: user presses voice button or says wake word.
Duration: Until user finishes speaking.

**Visual changes:**
```javascript
// Sphere color: shift from cyan (#00d4ff) to warm gold (#ffc040)
// Achieved via nodeMat uniform 'listenColor' lerped in loop()
const listenFactor = smoothstep(0, 1, listeningTimer / 0.4);  // 400ms transition
nodeMat.uniforms.listenColor.value = listenFactor;  // 0=cyan, 1=gold

// Node behavior: slow rotation, slight forward lean (toward camera)
const leanAmount = listenFactor * 0.15;  // nodes bias toward z+
net.rotation.x += (-leanAmount - net.rotation.x) * 0.03;  // lean toward camera

// Ear rings: 2 flat orbital rings, face-on to camera
earRing1.rotation.x = Math.PI / 2;  // horizontal plane
earRing2.rotation.x = Math.PI / 2;
earRing1.material.opacity = listenFactor;  // fade in
earRing2.material.opacity = listenFactor * 0.6;
earRing1.scale.setScalar(1 + listenFactor * 0.3);  // slightly larger than sphere

// Waveform: switch to incoming audio visualization (microphone input)
// Replace FFT source from TTS audio to microphone AnalyserNode
switchWaveformSource('microphone');

// Subtitle text
eVoice.textContent = transcript || 'Listening...';
```

**Color spec:**
| Element | Idle | Listening |
|---|---|---|
| Node core | `#00d4ff` (cyan) | `#ffc040` (gold) |
| Node bloom | cyan glow | warm amber glow |
| Edge lines | `rgba(0, 212, 255, 0.15)` | `rgba(255, 192, 64, 0.20)` |
| Core sphere | cyan | soft amber |

**Ear rings spec:**
- 2 torus geometries, `TorusGeometry(1.35, 0.012, 8, 64)` and `(1.55, 0.008, 8, 64)`
- `MeshBasicMaterial({ color: 0xffc040, transparent: true, opacity: 0 })`
- Always face camera (use `ring.quaternion.copy(camera.quaternion)` each frame)
- Slow counter-rotation between them

---

### State 2: THINKING

Activated when: voice server receives transcript, waiting for Ollama or Claude Code.
Duration: Until response ready.

**Visual changes:**
```javascript
// Bloom: slow ramp up during thinking
const thinkBloom = 2.8 + Math.sin(thinkingTimer * 1.2) * 0.4;  // gentle pulse
bloom.strength += (thinkBloom - bloom.strength) * dt * 0.8;

// Node organization: spiral pattern instead of random drift
// Override updateNodes() spiral phase when thinkingMode = true
if (thinkingMode) {
  const spiralPhase = thinkingTimer * 0.6;
  const spiralFactor = Math.min(1, thinkingTimer / 0.8);  // ramp in over 800ms
  // nodes.forEach: offset angle by spiralPhase * nodeIndex * 0.1
  // creates cascading spiral motion
}

// Processing ring: thin ring that sweeps 360° every 1.2s
processingRing.rotation.z = thinkingTimer * (Math.PI * 2 / 1.2);
processingRing.material.opacity = Math.min(0.8, thinkingTimer * 2);

// Text indicator
statusText.textContent = 'PROCESSING';
statusText.classList.add('processing-anim');  // animated ellipsis via CSS
```

**Processing ring spec:**
- `RingGeometry(1.1, 1.15, 64)` — thin ring just outside sphere
- `MeshBasicMaterial({ color: 0x00d4ff, transparent: true, side: THREE.DoubleSide })`
- Gradient texture: arc that goes full opacity for 60° sector, transparent for 300°
- Full rotation period: 1.2 seconds

**Spiral override spec:**
- In `updateNodes()`: when `thinkingMode`, add `spiralAngleOffset` to each node's azimuthal angle
- Offset increases with node index: `offset = spiralPhase * (nodeIndex / nodeCount) * Math.PI * 2`
- This creates a "cascading corkscrew" visual as nodes organize into a spiral

---

### State 3: ERROR

Activated when: Ollama returns error, Claude Code exits with error, or 3 consecutive tool errors.
Duration: 600ms flash, then return to previous state.

**Visual changes:**
```javascript
// Red ring pulse: brief flash of a red ring at sphere equator
errorRing.material.color.set(0xff2020);
errorRing.material.opacity = 1.0;

// Animate: flash on at t=0, fade out over 600ms
const decay = 1 - (errorFlashTimer / 0.6);
errorRing.material.opacity = Math.max(0, 1 - decay * decay);

// Node color: brief red tinge (listenColor goes negative = red shift)
nodeMat.uniforms.errorFlash.value = errorFlashTimer / 0.6;

// Subtitle: show error context
eVoice.textContent = "I'm having difficulty with that, sir.";
```

---

## Idle Improvements

### Particle Drift

At idle, a small fraction of nodes slowly drift off the sphere surface and return:

```javascript
// In updateNodes(), idle mode only:
const DRIFT_FRAC = 0.08;  // 8% of nodes drift at any time
const driftPhase = Math.sin(t * 0.3 + nodeIndex * 0.7);
const driftAmount = driftPhase > 0.92  // only top 8% of sine wave
  ? (driftPhase - 0.92) / 0.08 * 0.18  // max drift: 0.18 units off sphere
  : 0;
pos.multiplyScalar(1 + driftAmount);  // push outward
```

### Ambient Signals

Signal pulses continue at idle — just slower and dimmer:

```javascript
// Current: signals only fire during activeSmooth > 0.1
// v2: fire continuously, but at reduced rate and opacity at idle
const signalRate = 0.15 + activeSmooth * 0.85;  // 15% rate at idle, 100% when active
const signalOpacity = 0.3 + activeSmooth * 0.7;  // 30% opacity at idle
```

### Breathing Core

The core pulse gets a slow 4-second sinusoidal rhythm at idle:

```javascript
// Current: cp = 1 + audioRms * 5 + audioBass * 4
// v2 addition: idle breathing
const breathe = 0.06 * Math.sin(t * (Math.PI * 2 / 4.0));  // 4s period
const cp = 1 + breathe + audioRms * 5 + audioBass * 4 + activeSmooth * 1.2;
```

### Session Data Overlay

Small HUD always visible — session stats:

```html
<div id="session-hud">
  <span id="hud-uptime">00:00</span>
  <span id="hud-task">IDLE</span>
  <span id="hud-calls">0 calls</span>
</div>
```

```css
#session-hud {
  position: fixed;
  top: 16px;
  right: 20px;
  font-family: 'Rajdhani', monospace;
  font-size: 11px;
  color: rgba(0, 212, 255, 0.45);
  letter-spacing: 0.12em;
  display: flex;
  gap: 16px;
  text-transform: uppercase;
}
```

Updated by JavaScript every second:
```javascript
setInterval(() => {
  const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
  const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const s = (elapsed % 60).toString().padStart(2, '0');
  document.getElementById('hud-uptime').textContent = `${m}:${s}`;
  document.getElementById('hud-calls').textContent = `${toolCallCount} calls`;
}, 1000);
```

---

## Speech Quality Indicators

### High-confidence Ollama response
- `nodeMat.uniforms.speak.value` ramps to full intensity
- Bloom peaks at 3.2
- Normal bright cyan narration

### Fallback line (pre-cached, not Ollama-generated)
- `nodeMat.uniforms.speak.value` capped at 0.6
- Bloom peaks at 2.5
- Slightly cooler blue tint (`hue shift -15°` via uniform)

### Error state
- Red ring pulse (600ms)
- Bloom briefly drops to 1.8
- Subtitle turns `rgba(255, 80, 80, 0.9)`

Implementation: Voice server sends `{ type: "speech_quality", quality: "high"|"fallback"|"error" }` with each audio message. Browser applies corresponding visual class.

---

## VU Meter

During JARVIS speech, show 3-bar energy display below waveform:

```javascript
// In drawWave(), after existing waveform drawing:
function drawVUMeter(ctx, freqData, x, y, width, height) {
  const bassEnergy = average(freqData.slice(0, 4));    // 0-80Hz
  const midEnergy  = average(freqData.slice(4, 20));   // 80-400Hz
  const trebleEnergy = average(freqData.slice(20, 60)); // 400Hz+

  const bars = [bassEnergy, midEnergy, trebleEnergy];
  const barWidth = width / 5;
  const colors = ['#ff6040', '#00d4ff', '#40ffc0'];

  bars.forEach((energy, i) => {
    const barH = (energy / 255) * height;
    const bx = x + i * (barWidth + barWidth / 2);
    ctx.fillStyle = colors[i];
    ctx.globalAlpha = 0.7;
    ctx.fillRect(bx, y + height - barH, barWidth, barH);
  });
  ctx.globalAlpha = 1.0;
}
```

Position: bottom-left of the waveform canvas, 3 bars each 8px wide, 40px tall max.

---

## GLSL Shader Additions

Two new uniforms in `nodeMat` (existing `ShaderMaterial`):

```glsl
// Fragment shader additions
uniform float listenColor;  // 0=cyan, 1=gold
uniform float errorFlash;   // 0=normal, 1=red tinge

// In main():
vec3 baseColor = mix(
  vec3(0.0, 0.83, 1.0),   // cyan
  vec3(1.0, 0.75, 0.25),  // gold
  listenColor
);
baseColor = mix(baseColor, vec3(1.0, 0.12, 0.12), errorFlash * 0.6);
```

---

## Performance Constraints

All visual additions must maintain:
- **60fps at idle** on integrated Intel/AMD GPU
- **60fps during speech** (audio reactivity active)
- **< 200MB GPU memory** for Three.js scene

Guidelines:
- New geometry (ear rings, processing ring): use `BufferGeometry`, single draw call each
- Spiral animation: computed in JS, uploaded as `BufferAttribute` update (not per-frame shader)
- VU meter: drawn on existing `waveform` canvas — no new canvas
- Session HUD: DOM element, no Three.js overhead
- Breathing core: 1 `Math.sin()` call, no new geometry

---

## Foolproof Build Steps

### Step 1: Add new uniforms to nodeMat

In `jarvis-neural.html`, find the `nodeMat = new THREE.ShaderMaterial(...)` block.

Add to uniforms:
```javascript
listenColor: { value: 0.0 },
errorFlash: { value: 0.0 },
```

Add to fragment shader. **Test:** No visual change — uniforms at 0.

### Step 2: Add listening state color transition

Add `let listeningMode = false, listeningTimer = 0` to state variables.

In `loop()`:
```javascript
if (listeningMode) {
  listeningTimer = Math.min(1, listeningTimer + dt / 0.4);
} else {
  listeningTimer = Math.max(0, listeningTimer - dt / 0.3);
}
nodeMat.uniforms.listenColor.value = listeningTimer;
```

**Test:** `listeningMode = true` in console → sphere turns gold over 400ms.

### Step 3: Add ear rings

After existing ring creation code, add:
```javascript
const earRing1 = new THREE.Mesh(
  new THREE.TorusGeometry(1.35, 0.012, 8, 64),
  new THREE.MeshBasicMaterial({ color: 0xffc040, transparent: true, opacity: 0 })
);
const earRing2 = new THREE.Mesh(
  new THREE.TorusGeometry(1.55, 0.008, 8, 64),
  new THREE.MeshBasicMaterial({ color: 0xffc040, transparent: true, opacity: 0 })
);
scene.add(earRing1);
scene.add(earRing2);
```

In `loop()`, face them to camera and set opacity from `listeningTimer`.

**Test:** Rings appear and face camera when listening mode activates.

### Step 4: Add processing ring

```javascript
const processingRing = new THREE.Mesh(
  new THREE.RingGeometry(1.1, 1.15, 64),
  new THREE.MeshBasicMaterial({ color: 0x00d4ff, transparent: true, side: THREE.DoubleSide, opacity: 0 })
);
scene.add(processingRing);
```

In `loop()`: rotate and set opacity from `thinkingTimer`.

**Test:** Ring rotates when `thinkingMode = true` in console.

### Step 5: Add breathing core at idle

In `loop()`, find `const cp = 1 + audioRms * 5 + audioBass * 4 + activeSmooth * 1.2`.

Add: `+ 0.06 * Math.sin(t * (Math.PI * 2 / 4.0))`.

**Test:** Core breathes slowly at idle. Audio reactivity still works.

### Step 6: Add idle particle drift

In `updateNodes()`, at idle (`activeSmooth < 0.1`), add drift offset to node positions.

**Test:** At idle, a few nodes slowly drift off the surface.

### Step 7: Add session HUD

Add HTML element. Update via `setInterval`. Wire to `sessionStartTime` and `toolCallCount`.

**Test:** HUD shows correct uptime and tool call count.

### Step 8: Add VU meter to waveform canvas

In `drawWave()`, after existing waveform drawing, add VU meter.

**Test:** During speech, 3 colored bars visible below waveform.

### Step 9: Wire to voice server state messages

Parse `{ type: "status", state: "listening|thinking|speaking|idle" }` from WebSocket.
Set `listeningMode`, `thinkingMode` accordingly.

**Test:** Full end-to-end state transitions from voice server.
