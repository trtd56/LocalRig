# Intermittent token-bucket over-admission

Production traces appear to show two concurrent callers being admitted after only one token should have refilled. The incident was first seen near a wall-clock adjustment, so timer precision, async interleaving, and clock monotonicity are all suspected. Preserve the injected-clock API because tests and production instrumentation depend on it.
