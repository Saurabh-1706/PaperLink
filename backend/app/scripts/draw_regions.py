"""Visual check: draw stored regions back onto the rendered page images.

The overlay must land on the text it claims. This is the only practical way to catch a
coordinate-space bug — those fail silently with correct text and high confidence, so no
assertion on numbers alone will find them (docs/09-testing.md).

    python -m app.scripts.draw_regions <document_id> --org <organization_id> --out ./var/debug
"""
from __future__ import annotations

import argparse
import io
from pathlib import Path

from app.db.repositories import (
    AnswerRegionRepository,
    AnswerRepository,
    BlockRepository,
    DocumentRepository,
    PageRepository,
    QuestionRegionRepository,
    QuestionRepository,
)
from app.db.session import session_scope
from app.modules.extraction.ir import denormalize_bbox
from app.schemas.common import BBox
from app.storage.factory import get_storage

COLOURS = {"block": (0, 128, 255), "question": (0, 170, 0), "answer": (220, 0, 0)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("document_id")
    parser.add_argument("--org", required=True)
    parser.add_argument("--out", default="./var/debug")
    args = parser.parse_args()

    from PIL import Image, ImageDraw

    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)
    storage = get_storage()

    with session_scope() as session:
        document = DocumentRepository(session).get_or_404(args.org, args.document_id)
        pages = PageRepository(session).for_document(args.org, document.id)
        blocks = BlockRepository(session)

        question_rows = QuestionRepository(session).for_assessment(args.org, document.assessment_id)
        question_regions = QuestionRegionRepository(session).for_questions(
            args.org, [row.id for row in question_rows]
        )
        answer_rows = AnswerRepository(session).for_assessment(args.org, document.assessment_id)
        answer_regions = AnswerRegionRepository(session).for_answers(
            args.org, [row.id for row in answer_rows]
        )

        for page in pages:
            if not page.rendered_image_uri:
                continue
            raw = storage.get(page.rendered_image_uri, organization_id=args.org)
            image = Image.open(io.BytesIO(raw)).convert("RGB")
            draw = ImageDraw.Draw(image)

            for block in blocks.list(args.org, page_id=page.id):
                _rect(draw, image, BBox.from_list(block.bbox), COLOURS["block"], 1)
            for region in question_regions:
                if region.page_number == page.page_number:
                    _rect(draw, image, BBox.from_list(region.bbox), COLOURS["question"], 3)
            for region in answer_regions:
                if region.page_number == page.page_number:
                    _rect(draw, image, BBox.from_list(region.bbox), COLOURS["answer"], 3)

            target = output_dir / f"{document.id}-page-{page.page_number}.png"
            image.save(target)
            print(f"wrote {target}")


def _rect(draw, image, bbox: BBox, colour: tuple[int, int, int], width: int) -> None:
    x1, y1, x2, y2 = denormalize_bbox(bbox, image.width, image.height)
    draw.rectangle([x1, y1, x2, y2], outline=colour, width=width)


if __name__ == "__main__":
    main()
