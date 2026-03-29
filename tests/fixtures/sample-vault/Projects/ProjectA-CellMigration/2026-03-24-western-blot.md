---
date: 2026-03-24
project: ProjectA-CellMigration
experiment_type: western-blot
protocol: "[[western-blot-protocol]]"
samples:
  - name: Sample 1
    condition: control
  - name: Sample 2
    condition: treated-24h
  - name: Sample 3
    condition: treated-48h
reagents:
  - anti-GAPDH (1:5000)
  - anti-p53 (1:1000)
result_summary: >
  Bands at 50kDa and 75kDa. 50kDa stronger
  in treated samples, dose-dependent.
attachments:
  - attachments/gel-image-001.png
status: complete
tags: [western-blot, p53, cell-migration]
---

# Western Blot — p53 Expression in Migrating Cells

## Objective
Measure p53 protein levels after treatment with migration-inducing factors.

## Methods
Following [[western-blot-protocol]] with modifications:
- Used 10% SDS-PAGE gel
- Transfer at 100V for 1.5h

## Results
Bands observed at 50kDa (strong) and 75kDa (weak).
50kDa band intensity: Sample 1 < Sample 2 < Sample 3 (dose-dependent increase).

## Notes
Need to repeat with additional time points.
