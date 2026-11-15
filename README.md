# Kerbstone

**Draw a circuit. Build your car. Race it.** A browser racing game with sim-cade
handling, a freehand track studio and a tunable garage. No downloads and no
assets: every texture, model and sound is generated in code.

**Play:** https://thatcomputerguydesigns.github.io/LapwerksButBetter/ (rebuilt and redeployed on every push)

**Run locally:** `npm start` (installs dependencies, starts the dev server and opens the browser)

## What's in this build

- **Track Studio.** Draw a loop with mouse, finger or pen and it morphs into a smooth circuit.
  Sharp kinks are relaxed to a drivable radius, and the start line goes on the longest straight.
  You can drag, add or remove control points, and set width, elevation, banking and scenery.
  The studio shows length, corner count, an elevation profile and an estimated lap time for
  your car. When the track crosses itself, a flyover with pillars is built automatically.
  There is also a random circuit generator, and you can start from any preset.
- **Circuits.** Kerbs on corners, gravel traps on corner exits, mowed-grass runoff, guard rails
  that stay clear of nearby sections, braking boards placed from the speed profile,
  a start gantry with working lights, pit garages, grandstands, trees and distant hills.
- **Driving model** (`src/physics/vehicle.js`, pure JS, same code in browser and Node):
  - combined-slip tyres with load sensitivity and surface temperature (warm-up and overheating)
  - dynamic weight transfer with a roll-stiffness split
  - aero downforce and drag with adjustable balance
  - slope and banking applied through gravity, grip that changes by surface
  - engine torque curve, gearbox, clutch launch and limited-slip diff
  - assists: ABS with EBD, traction control, a stability aid, and steering help that limits
    front slip angle and allows natural countersteer. Three presets: Casual, Sport and Pro.
- **Garage.** Three bodies, tyre compounds, drivetrain swap, paint, finish, livery, number
  and rims. Nine tuning settings. Performance figures (0–100, top speed, grip) come from
  running the real physics model.
- **Racing.** Start lights, lap and sector timing, a live delta, track limits, a ghost of your
  best lap, saved personal bests, a colour-coded driving line, five cameras, tyre smoke,
  skid marks, and synthesised engine, tyre, kerb, wind and impact audio.
- **Controls.** Keyboard (speed-sensitive steering smoothing), gamepad (analog input with
  deadzones and response curves) and touch (steering pad and pedals).
- **Sharing and exports.** Share links (the whole circuit is encoded in the URL),
  import by link or code, and export as track JSON, centerline CSV
  (x/y/z, width, bank, curvature, kerbs) or a 3D `.glb` model.

## Proving the handling

```
npm test        # regression checks (run in CI before every deploy)
npm run sim     # AI lap simulation on every preset → lap time vs theoretical optimum,
                # peak g, spins, off-tracks, tyre temps   (--all-cars, --sport, --svg)
node sim/skidpad.mjs gt 25   # steady-state ramp-steer test (understeer gradient, limit g)
```

With Sport assists, the AI driver laps every preset within about 2–4% of the
quasi-steady-state optimum and without spins. Car and compound ordering holds
across all 45 combinations.
