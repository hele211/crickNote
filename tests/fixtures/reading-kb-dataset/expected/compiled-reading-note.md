---
title: IL-42 suppresses activated CD8 T cells by lowering granzyme B
authors: [Lee H, Raman S, Ortega M]
year: 2026
journal: Journal of Experimental Immunology
doi: 10.1234/jei.2026.0042
read_date: 2026-04-12
status: complete
kb_status: pending
sources:
  - type: notes
    path: paper.md
  - type: notebooklm
    path: notebooklm-summary.md
  - type: notes
    path: claude-notes.md
related_projects: [P001]
tags: [reading, immunology, il-42, cd8]
---

# IL-42 suppresses activated CD8 T cells by lowering granzyme B

## Claims

- IL-42 suppresses activated CD8 effector output, with the clearest effect seen in reduced granzyme B.
- The suppression appears stronger in primary human CD8 cells than in Jurkat cells.
- The effect does not appear to require direct cell-cell contact under the tested transwell condition.

## Reasoning

The authors compared activated CD8 cells with and without recombinant IL-42, then separated early activation readouts from later effector readouts. Because CD69 changed minimally while granzyme B and IFN-gamma dropped, they argue IL-42 acts on effector function rather than initial activation. The transwell experiment is used to argue for a soluble, contact-independent mechanism.

## Evidence

- 20 ng/mL IL-42 reduced granzyme B-positive primary CD8 cells by 38 percent.
- IFN-gamma-positive cells dropped by 24 percent at the same dose.
- CD69 changed by less than 5 percent.
- Jurkat cells showed only about 15 percent granzyme B reduction.
- Anti-IL-42 antibody restored granzyme B close to baseline.

## Assumptions

- The 24-hour assay captures the biologically relevant suppression window.
- Granzyme B is treated as the main mechanistic readout of suppression.
- The transwell result is assumed to reflect a true contact-independent effect rather than an artifact of the assay setup.
- Jurkat cells are assumed to be informative even though they show a weaker effect than primary cells.

## Takeaways

This paper is useful for any project tracking cytokine-mediated CD8 suppression. The strongest reusable knowledge is not just that IL-42 matters, but that granzyme B is the best readout and that the mechanism may be contact-independent. It is a good source for the IL-42 entity note, a CD8 suppression concept note, and a flow-cytometry assay method note.

## Extensions

- Identify the receptor or downstream pathway responsible for the IL-42 effect.
- Test whether the contact-independent result reproduces across other cell systems.
- Check whether primary-cell suppression persists at longer time points or in vivo.
- Compare IL-42 against other suppressive cytokines using the same granzyme B-focused assay.
