# F-006 web storage/readback split before/after

## Before evidence
- Artifact: forensics/20260418T_f006_web_class_split_surface/f006_explain_trace.txt
- Explicit web storage/readback distinction block present: no

## After evidence
- Artifact: forensics/20260419T_f006_web_storage_readback_split/f006_storage_readback_explain_trace.txt
- Artifact: forensics/20260419T_f006_web_storage_readback_split/f006_storage_readback_selector_trace.txt
- Explicit web storage/readback distinction block present in explain: yes
- Explicit web storage/readback distinction block present in retrieval trace: yes
- Evidence ids show class-separated readback: web_evidence id w_ev_01 vs web_promoted id w_pr_01
- Evidence types show class-separated readback: web_evidence vs web_promoted_fact

## Distinct class readback proof markers
- web_evidence: storage_class=staged_external_evidence
- web_promoted: storage_class=promoted_reusable_web_knowledge
- collapsed_web_bucket=no