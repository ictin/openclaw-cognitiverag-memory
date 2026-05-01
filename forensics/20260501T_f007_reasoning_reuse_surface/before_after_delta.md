# F-007 reasoning-memory reuse surface before/after

## Before evidence
- Artifact: forensics/20260419T_f006_web_storage_readback_split/f006_storage_readback_explain_trace.txt
- Explicit reasoning-memory reuse distinction block present: no

## After evidence
- Artifact: forensics/20260501T_f007_reasoning_reuse_surface/f007_reasoning_reuse_explain_trace.txt
- Artifact: forensics/20260501T_f007_reasoning_reuse_surface/f007_reasoning_reuse_selector_trace.txt
- Explicit reasoning-memory reuse distinction block present in explain: yes
- Explicit reasoning-memory reuse distinction block present in retrieval trace: yes
- Distinct ids: reasoning_reuse=r_case_01 vs generic_promoted=p_fact_01
- Distinct types: reasoning_record vs promoted_fact

## Distinct reuse proof markers
- reasoning_reuse visible=yes
- collapsed_into_generic_promoted=no