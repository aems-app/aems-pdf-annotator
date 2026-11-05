"""Deleted comment recovery must ship the Swedish host catalog entries."""

import gettext
from pathlib import Path


def test_deleted_comment_recovery_swedish_catalog() -> None:
    catalog = (
        Path(__file__).resolve().parents[1]
        / "src/aems/web/translations/sv/LC_MESSAGES/messages.mo"
    )
    assert catalog.is_file(), "The Swedish deleted-comment recovery catalog is missing"
    with catalog.open("rb") as stream:
        translate = gettext.GNUTranslations(stream).gettext
    assert translate(
        "This comment was deleted. Your text is kept. You can re-create it as a new comment."
    ) == (
        "Kommentaren har tagits bort. Din text finns kvar. "
        "Du kan återskapa den som en ny kommentar."
    )
    assert translate("Re-create comment") == "Återskapa kommentar"
