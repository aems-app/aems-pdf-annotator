"""Stale-comment conflict recovery must ship the Swedish host catalog entries."""

import gettext
from pathlib import Path


def test_comment_conflict_recovery_swedish_catalog() -> None:
    catalog = (
        Path(__file__).resolve().parents[1]
        / "src/aems/web/translations/sv/LC_MESSAGES/messages.mo"
    )
    with catalog.open("rb") as stream:
        translate = gettext.GNUTranslations(stream).gettext
    assert translate(
        "Someone else changed this comment after you opened it. Their version is shown; "
        "your change was not saved."
    ) == (
        "Någon annan ändrade kommentaren efter att du öppnade den. Deras version visas; "
        "din ändring sparades inte."
    )
    assert translate("Use my text") == "Använd min text"
