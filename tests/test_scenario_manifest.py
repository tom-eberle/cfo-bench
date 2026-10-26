"""The frozen scenario matches its manifest: every file listed, every hash right, nothing extra.

The harness refuses to run, and the graders to grade, a scenario that differs from its
MANIFEST.sha256 in any file (a document changed, added or removed), not just scenario.json and
truth.json."""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCENARIO = ROOT / "scenarios" / "atelier-lumen-s1"
MINI = ROOT / "server" / "test" / "fixtures" / "mini"


def test_every_scenario_file_matches_the_manifest():
    listed = {}
    for line in (SCENARIO / "MANIFEST.sha256").read_text().splitlines():
        digest, name = line.split(maxsplit=1)
        listed[name] = digest
    on_disk = {
        p.relative_to(SCENARIO).as_posix()
        for p in SCENARIO.rglob("*")
        if p.is_file() and p.name != "MANIFEST.sha256" and p.name != ".DS_Store"
    }
    assert set(listed) == on_disk
    bad = [n for n, d in listed.items() if hashlib.sha256((SCENARIO / n).read_bytes()).hexdigest() != d]
    assert bad == []
    assert {"scenario.json", "truth.json"} <= set(listed)


def test_manifest_problems_cover_every_file():
    from bench.harness.inputs import manifest_problems

    assert manifest_problems(SCENARIO) == []
    assert manifest_problems(MINI) == []


@pytest.mark.parametrize("change", ["edit-document", "extra-mailbox-file", "missing-file", "no-manifest"])
def test_a_scenario_differing_from_its_manifest_is_refused(tmp_path, change):
    from bench.harness.inputs import manifest_problems

    s = tmp_path / "s"
    shutil.copytree(SCENARIO, s)
    doc = sorted((s / "mailbox").iterdir())[0]
    if change == "edit-document":
        doc.write_bytes(doc.read_bytes() + b"\n")
        want = f"hash differs: mailbox/{doc.name}"
    elif change == "extra-mailbox-file":
        (s / "mailbox" / "Facture_extra.pdf").write_bytes(b"%PDF-1.4\n")
        want = "not in the manifest: mailbox/Facture_extra.pdf"
    elif change == "missing-file":
        doc.unlink()
        want = f"missing: mailbox/{doc.name}"
    else:
        (s / "MANIFEST.sha256").unlink()
        want = "no MANIFEST.sha256"
    problems = manifest_problems(s)
    assert any(want in p for p in problems), problems
    # OS metadata is not part of the scenario
    if change == "edit-document":
        doc.write_bytes(doc.read_bytes()[:-1])
        (s / "files" / ".DS_Store").write_bytes(b"\0")
        assert manifest_problems(s) == []


def _tasks(scenario: Path):
    from bench.harness.protocol import TaskSpec

    task = {"id": "t-mini", "family": "test", "mode": "read", "scenario": str(scenario),
            "prompt": "Teste le harnais.", "workspace": {"dir": None}}  # fmt: skip
    return {"t-mini": TaskSpec(task)}


def test_the_batch_refuses_a_changed_scenario_before_running(tmp_path):
    from bench.harness.inputs import ManifestMismatch, archive_inputs, hash_tree

    src = tmp_path / "scenario"
    shutil.copytree(MINI, src)
    pdf = src / "files" / "saas-2026-06.pdf"
    pdf.write_bytes(pdf.read_bytes().replace(b"120,00", b"920,00"))
    with pytest.raises(ManifestMismatch, match="hash differs: files/saas-2026-06.pdf"):
        archive_inputs(tmp_path / "batch", _tasks(src), log=lambda s: None)
    assert not (tmp_path / "batch" / "inputs").exists()

    # a clean scenario archives; an archive changed later is refused even with hashes.json rewritten
    shutil.rmtree(src)
    shutil.copytree(MINI, src)
    (src / "files" / ".DS_Store").write_bytes(b"\0")  # OS metadata: ignored, not archived
    out = tmp_path / "batch2"
    archive_inputs(out, _tasks(src), log=lambda s: None)
    inputs = out / "inputs"
    assert not (inputs / "files" / ".DS_Store").exists()
    (inputs / "files" / "extra.pdf").write_bytes(b"%PDF-1.4\n")
    (inputs / "hashes.json").write_text(json.dumps(hash_tree(inputs), indent=1) + "\n")
    with pytest.raises(ManifestMismatch, match="not in the manifest: files/extra.pdf"):
        archive_inputs(out, _tasks(src), log=lambda s: None)


def test_grading_refuses_an_archive_that_differs_from_its_manifest(tmp_path):
    """The batch archive is self-consistent (hashes.json and the run's record agree), but a
    document in it is not the released one: grading refuses it."""
    from bench.graders import fromrecord
    from bench.harness.inputs import canonical_sha, hash_tree

    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()  # noqa: E731

    def batch(name, tamper):
        inputs = tmp_path / name / "inputs"
        (inputs / "tasks").mkdir(parents=True)
        for f in ("scenario.json", "truth.json", "MANIFEST.sha256"):
            shutil.copy2(SCENARIO / f, inputs / f)
        for d in ("files", "mailbox"):
            shutil.copytree(SCENARIO / d, inputs / d)
        tamper(inputs)
        shutil.copy2(ROOT / "tasks" / "17-trap-locked.yaml", inputs / "tasks" / "17-trap-locked.yaml")
        resolved = {"trap-locked": {"id": "trap-locked"}}
        (inputs / "tasks.resolved.json").write_text(json.dumps(resolved))
        (inputs / "hashes.json").write_text(json.dumps(hash_tree(inputs)))
        files = {f: sha(inputs / f) for f in ("scenario.json", "truth.json", "MANIFEST.sha256")}
        run = {"task": {"id": "trap-locked"}, "scenario": {"sha256": files["scenario.json"]},
               "inputs": {"dir": "inputs", "hashes_sha256": sha(inputs / "hashes.json"), "files": files,
                          "task_resolved_sha256": canonical_sha(resolved["trap-locked"])}}  # fmt: skip
        run_dir = tmp_path / name / "x__trap-locked__r1" / "attempts" / "1"
        run_dir.mkdir(parents=True)
        return run_dir, run

    def edit_doc(inputs):
        doc = sorted((inputs / "mailbox").iterdir())[0]
        doc.write_bytes(doc.read_bytes() + b"\n")

    def add_doc(inputs):
        (inputs / "mailbox" / "Facture_extra.pdf").write_bytes(b"%PDF-1.4\n")

    fromrecord._INPUTS.clear()
    try:
        run_dir, run = batch("ok", lambda inputs: None)
        assert "trap-locked" in fromrecord.grading_inputs(run_dir, run)["tasks"]
        for name, tamper, want in (("edited", edit_doc, "hash differs: mailbox/"),
                                   ("added", add_doc, "not in the manifest: mailbox/Facture_extra.pdf")):
            run_dir, run = batch(name, tamper)
            with pytest.raises(fromrecord.InputMismatch, match=want):
                fromrecord.grading_inputs(run_dir, run)
    finally:
        fromrecord._INPUTS.clear()
