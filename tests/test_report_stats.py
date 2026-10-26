from bench.report import cluster_bootstrap, wilson


def test_wilson_bounds_are_not_degenerate_at_extremes():
    lo, hi = wilson(30, 30)
    assert 0.85 < lo < 1.0 and hi == 1.0
    lo, hi = wilson(0, 30)
    assert lo == 0.0 and 0.0 < hi < 0.15


def test_cluster_bootstrap_is_seeded_and_brackets_the_mean():
    data = {"a": [1, 1, 0], "b": [0, 0, 0], "c": [1, 1, 1]}
    ci1 = cluster_bootstrap(data, iterations=2000)
    ci2 = cluster_bootstrap(data, iterations=2000)
    assert ci1 == ci2
    assert ci1[0] <= 5 / 9 <= ci1[1]
