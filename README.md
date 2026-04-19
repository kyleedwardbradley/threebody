# Three-Body z-probe

An in-browser simulation of a massless test particle on the z-axis of a symmetric, equal-mass binary whose orbits lie in the x–y plane. The user sets the initial vertical velocity and the phase of the binary ("time of year"); the app integrates the resulting one-dimensional motion, detects each z = 0 crossing, and plots the crossing velocity against the calendar phase in a polar diagram.

Live: `https://<user>.github.io/threebody/`

---

## 1. Physical setup

Two bodies of equal mass `m` orbit their common centre of mass in the x–y plane on identical elliptical orbits of user-selected eccentricity `e`. The orbits are *oppositional*: at all times the bodies sit on opposite sides of the origin, so

$$\vec r_2(t) = -\vec r_1(t).$$

A massless test particle is constrained to the z-axis. By the symmetry of the two gravitating masses, transverse forces on the particle cancel exactly, leaving only a z-component.

Define `r(t) = |\vec r_1(t)|`, the distance of either body from the origin. Then the distance from the test particle at `(0, 0, z)` to either body is `d = √(r² + z²)`, and the gravitational acceleration of the particle is

$$\ddot z = -\frac{2 G m z}{(r^2 + z^2)^{3/2}}.$$

The motion is therefore completely described by a two-dimensional non-autonomous system:

$$\dot z = v, \quad \dot v = -\frac{2 G m z}{(r^2 + z^2)^{3/2}}.$$

Here `r(t)` is the *exogenous* oscillation of the binary — integrable in closed form via Kepler's equation — and enters the ODE as a time-dependent coefficient.

## 2. Units and conventions

We non-dimensionalise by choosing:

- `2 G m = 1`, absorbing the coupling constant into time.
- `a_rel = 1` (semi-major axis of the *relative* orbit). Each body's orbit then has `a_body = ½`, and the body–origin distance oscillates in `[(1 − e)/2, (1 + e)/2]`.
- Kepler's third law gives the period `T² = 4π² a_rel³ / (G M_tot) = 4π² / 1`, hence `T = 2π`.

The "calendar phase" `τ ∈ [0, 1)` is defined as the fractional position in the orbital period, with `τ = 0` corresponding to mutual apogee (eccentric anomaly `E = π`). The user's initial-phase slider `τ₀` therefore chooses where in the year the simulation begins; `τ₀ = 0.5` starts at perihelion.

## 3. Numerical framework

| Layer | Technology | Role |
|---|---|---|
| Build / dev | Vite + TypeScript | bundling, HMR, worker import syntax |
| 3D view | Three.js (WebGL) | orbits, bodies, particle, trail |
| 2D plot | Canvas2D | polar scatter of crossings |
| Compute | Web Worker (float64) | off-thread integration + crossing detection |
| Math | hand-rolled JS, no external numerical library | |

All numerics use IEEE-754 `double` (JS `Number` / `Float64Array`). No arbitrary-precision arithmetic is needed at the accuracies of interest.

## 4. Kepler solver (`src/physics/kepler.ts`)

The relative orbit satisfies Kepler's equation

$$M = E - e \sin E, \quad M(t) = \pi + 2\pi \left( \tau_0 + \frac{t}{T} \right),$$

with the `+ π` offset chosen so that `(t = 0, τ₀ = 0)` maps to apogee (`E = π`).

Given `M`, the eccentric anomaly `E` is found by **Newton's method**:

```
E ← M + e·sin M                 # initial guess
repeat:
    f  = E − e·sin E − M
    f' = 1 − e·cos E
    E  ← E − f / f'
until |f / f'| < 1e−14
```

Convergence is quadratic; in practice 3–5 iterations suffice for `e < 0.95`. The body–origin distance is then

$$r(t) = \frac{1}{2} \left( 1 - e \cos E \right),$$

and position in the x–y plane is `(x, y) = ½ · (cos E − e, √(1−e²) · sin E)` (used only by the 3D view).

The solver is called on every RHS evaluation inside the ODE step — it is cheap and exact in float64.

## 5. ODE integrator (`src/physics/dopri5.ts`)

A hand-rolled **Dormand–Prince 5(4)** Runge–Kutta integrator (FSAL — seven stages, first stage of the next step equals the last stage of this one). Adaptive step size uses a **PI controller** on the embedded 4th-order error estimate with `rtol = 1e-9`, `atol = 1e-12`. These are tight enough to match float64 roundoff on the state over tens of thousands of periods while remaining cheap (typical step ≈ `T/50` away from perihelion, shrinking as needed when `r(t)` approaches periapsis).

Coefficients are those in Hairer, Nørsett & Wanner, *Solving Ordinary Differential Equations I*, §II.5.

The integrator retains snapshots of the previous step (`tLast, hLast, yLast, fLast`) alongside the current state so that crossing refinement has a smooth interpolant available with no extra RHS evaluations.

## 6. Plane-crossing detection (`src/physics/sim.ts`)

Each accepted step yields states at `tₙ` and `tₙ + hₙ`. If `z` changes sign across the step, there is exactly one `z = 0` crossing in the interior. To locate it to float64 precision we use a **cubic Hermite interpolant** on the step:

$$\hat z(\theta) = h_{00}(\theta) z_n + h \cdot h_{10}(\theta) v_n + h_{01}(\theta) z_{n+1} + h \cdot h_{11}(\theta) v_{n+1}$$

with the standard Hermite basis polynomials on `θ ∈ [0, 1]`. `\hat z` is 4th-order accurate, which is more than sufficient for root-finding purposes. Starting from the secant estimate `θ₀ = zₙ / (zₙ − zₙ₊₁)`, we run **Newton's method on the interpolant**:

$$\theta_{k+1} = \theta_k - \frac{\hat z(\theta_k)}{\hat z'(\theta_k)},$$

where `\hat z'` is the derivative of the same Hermite polynomial. Convergence is reached in 2–4 iterations to `|dθ| < 1e-14`.

At the refined `θ*` we compute:

- crossing time `t* = tₙ + θ* · h`
- crossing velocity `v* = \hat v(\theta*)` (Hermite interpolation of the `v` component)
- crossing phase `τ* = frac(τ₀ + t*/T)`

and record `(t*, τ*, v*)`. Up- and down-crossings (`v* > 0` vs. `v* < 0`) are distinguished by the sign of `v*`.

## 7. Simulation driver (`src/worker.ts`)

The simulation runs in a dedicated Web Worker so the main thread stays responsive. Two pacing modes:

- **Real-time (multiplier N×):** target simulation time `t_target = t_start + (now − wall_start) · N · T/2` per tick. `N = 1` gives one orbital period per two wall seconds.
- **Fast as possible:** advance for a fixed wall-time budget (~8 ms) per tick, unbounded in simulation time.

The worker emits two kinds of messages to the main thread:

- `snapshot` (≈ 60 Hz) — current `(t, z, v, τ, bx, by)` for rendering.
- `crossings` — batches of `(t, τ, v)` tuples accumulated since the last tick.

The simulation halts once `maxCrossings` are recorded.

## 8. Plotting

### 3D system view (`src/view3d.ts`)

- Oblique perspective camera with Three.js `OrbitControls` for interactive rotate / zoom.
- Two spheres at `±(x, y, 0)` trace the orbital ellipses (drawn as polylines).
- A faint x–y grid and extended z-axis line provide spatial context.
- The test particle is rendered at `(0, 0, z)`; it is free to leave the viewport when z is large.
- A **particle trail** is rendered as a `THREE.Points` with per-vertex colours. Colours are recomputed each frame by point age: newest samples are green, oldest fade to black (quadratic ramp), blending into the dark background. The trail length auto-scales with simulation speed (faster ⇒ more samples) while the `Trail` slider provides an overall quality factor.

### Polar crossing plot (`src/polarPlot.ts`)

Each recorded crossing becomes one dot on a polar scatter:

- **Angle** `θ = 2π · τ*` — calendar phase, with τ = 0 at the top and increasing clockwise.
- **Radius** `r = |v*|` — magnitude of vertical velocity at the crossing.
- **Colour**: green for up-crossings (`v* > 0`), pink for down-crossings (`v* < 0`).

Radial ticks auto-adjust to a rounded-up `vmax`. Twelve month markers are drawn purely for orientation — they have no physical significance; a "year" is just one period of the binary.

## 9. Controls reference

| Control | Effect |
|---|---|
| `Eccentricity` | binary eccentricity `e`. Restarts the sim. |
| `Initial z' (v₀)` | initial vertical velocity of the test particle (`z₀ = 0` implicit). Restarts the sim. |
| `Initial phase τ₀` | calendar phase at which `t = 0`. `0` = mutual apogee, `0.5` = mutual perihelion. Restarts the sim. |
| `Max crossings` | stop condition; cap on number of points plotted. |
| `Speed` | 0.2× – 20× realtime (log-scaled), or `MAX` for unbounded. 1× = one orbital period per two wall seconds. Does not restart the sim. |
| `Trail` | visible trail length (quality factor; actual point count scales with speed). |
| `Run` / `Pause` / `Reset` | Pause state persists across Reset — resetting while paused shows the `t = 0` state without advancing it. |

All numeric entries are editable directly in the small text boxes. The speed box accepts either a number (e.g. `3.5`) or the word `max`.

## 10. Development

```bash
conda env create -f environment.yml    # or `conda env update -n <env> -f environment.yml`
conda activate threebody
npm install
npm run dev                            # http://localhost:5173
```

`npm run build` produces a static `dist/`. Set `BASE_URL=/sub/path/` to build with a non-root base path (needed for GitHub Pages).

### Deployment

A GitHub Actions workflow (`.github/workflows/deploy.yml`) builds the app and publishes `dist/` to GitHub Pages on every push to `main`. The workflow injects `BASE_URL=/<repo-name>/` automatically, so renaming the repo does not require any code changes.

## 11. References

- Hairer, E.; Nørsett, S. P.; Wanner, G. *Solving Ordinary Differential Equations I: Nonstiff Problems*, 2nd ed., Springer, 1993 — Dormand–Prince coefficients, error estimator, dense output.
- Danby, J. M. A. *Fundamentals of Celestial Mechanics*, 2nd ed., Willmann-Bell, 1992 — Kepler's equation, Newton iteration, orbit parameterisation.
