# Adaptive ETA model

Use this reference when explaining, testing, or changing the ETA calculation.

## What `high confidence` means

The visible range targets 90% coverage: the model intends the eventual remaining active-work time to fall inside the parenthesized range about nine times out of ten. It does **not** mean the center estimate is nearly certain. Sparse evidence keeps the same high-coverage target by making the range wider; repeated relevant observations can narrow it.

If timing evidence is absent, the renderer says `CALIBRATING`. A critical blocker says `PAUSED`. Neither state claims high confidence.

## Inputs

For every required task, maintain:

- relative weight and evidence-backed progress;
- cumulative active-work `elapsed_minutes`;
- current bottom-up `remaining_minutes` when defensible;
- `initial_estimate_minutes`, preserved rather than overwritten;
- `task_type` and optional task timestamps so recent, relevant task history gets more influence;
- uncertainty and blockers.

Record forecast checkpoints as work progresses. Timestamps order the observations, but wall-clock time is never treated as active work automatically because it can include user waits, approvals, idle time, or unattended jobs.

## Calculation

### 1. Completion

```text
earned points = sum(weight × progress)
completion = earned points / total required points
```

### 2. Learn multiplicative forecast error

For each completed task with an initial estimate:

```text
error ratio = actual active minutes / initial estimate
log error = ln(error ratio)
```

The model estimates the weighted mean and variance of log error. Recent observations matter more, and observations with the same `task_type` receive more weight. Partial tasks contribute fractional evidence through their implied total time:

```text
implied total = elapsed active minutes / progress
```

The model begins with a conservative shrinkage prior: 1.2× median bias, log standard deviation 0.65, and three prior-equivalent observations. Real task evidence gradually replaces that prior. Log ratios are used because effort errors are positive, commonly multiplicative and heteroscedastic; they also treat equal-factor under- and over-estimates symmetrically.

### 3. Produce independent ETA candidates

- **Calibrated task simulation:** each incomplete task uses its current remaining estimate, learned task-type bias, uncertainty distribution, and explicit risk events. A deterministic 6,000-run Monte Carlo simulation sums the tasks and includes shared project uncertainty.
- **Whole-project throughput:** cumulative active minutes per earned point multiplied by remaining points.
- **Recent throughput:** active minutes per newly earned point since the latest useful checkpoint.
- **Stall correction:** if active minutes increased but earned progress did not, the previous ETA is moved upward and receives extra weight.

The center ETA is a reliability-weighted geometric combination of the available candidates. Geometric pooling fits the multiplicative error model and prevents one very large candidate from dominating as strongly as an arithmetic mean.

### 4. Build the 90% range

The central interval is:

```text
low  = ETA × exp(-1.64485 × σ)
high = ETA × exp(+1.64485 × σ)
```

`σ` is never a fixed UI multiplier. It is the larger of the simulated task spread, learned forecast-error spread, and an evidence-stage floor, with extra width when the independent ETA candidates disagree. The floor decreases from `prior` to `learning` to `calibrated` as relevant observations accumulate.

## Why this design

The implementation follows converging findings from software estimation and probabilistic forecasting:

- Human task forecasts are systematically optimistic when they focus on the plan instead of relevant past outcomes: [Buehler, Griffin, and Ross (1994)](https://bear.warrington.ufl.edu/brenner/mar7588/Papers/buehler-et-al-1994.pdf).
- Software prediction intervals can be built from the empirical distribution of previous estimation accuracy: [Jørgensen, Sjøberg, and Kirkebøen (2003)](https://doi.org/10.1016/S0950-5849(02)00188-X).
- Software professionals' nominal 90% ranges have historically covered only about 60–70% of actual effort, so subjective confidence labels alone are unsafe: [Jørgensen (2007)](https://doi.org/10.1016/j.ijforecast.2007.05.008).
- Probabilistic software estimates should maximize informativeness subject to calibration: [Jørgensen (2019)](https://doi.org/10.1016/j.infsof.2019.08.006) and [Gneiting, Balabdaoui, and Raftery (2007)](https://doi.org/10.1111/j.1467-9868.2007.00587.x).
- Forecast combinations can outperform their components, with past errors informing weights: [Bates and Granger (1969)](https://doi.org/10.1057/jors.1969.103).
- Log accuracy ratios avoid important relative-error bias under multiplicative error: [Tofallis (2015)](https://doi.org/10.1057/jors.2014.103).
- Online intervals should adapt when the generating process shifts: [Gibbs and Candès (2021)](https://arxiv.org/abs/2106.00170).
- Monte Carlo schedule analysis should combine activity-duration distributions, explicit risks, and schedule logic: [U.S. GAO Schedule Assessment Guide](https://www.gao.gov/assets/gao-16-89g.pdf) and [NASA Cost Estimating Handbook Appendix G](https://www.nasa.gov/wp-content/uploads/2020/11/ceh_appg.pdf).
- Reference-class corrections should use outcomes from similar past work and update as local evidence grows: [Flyvbjerg (2008)](https://doi.org/10.1080/09654310701747936) and [HM Treasury optimism-bias guidance](https://www.gov.uk/government/publications/green-book-supplementary-guidance-optimism-bias).

## Limits

- A 90% target becomes empirically trustworthy only after enough comparable forecasts resolve; the early range is a conservative prior, not a formal guarantee.
- Progress fractions remain judgment calls unless backed by concrete subtasks or acceptance evidence.
- Active-work ETA is not a calendar deadline. Parallel agents, work schedules, and unattended waiting require a separate calendar model.
- New scope must be added to the denominator. No statistical formula can compensate for deliberately omitted required work.
