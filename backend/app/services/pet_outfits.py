OUTFIT_SLOTS = ("head", "neck", "side", "scene")

PET_OUTFIT_CATALOG = {
    "pig": (
        {
            "id": "pig_basic_scarf",
            "slot": "neck",
            "unlock_level": 1,
        },
        {
            "id": "pig_sleep_cap",
            "slot": "head",
            "unlock_level": 2,
        },
        {
            "id": "pig_bell",
            "slot": "side",
            "unlock_level": 3,
        },
        {
            "id": "pig_work_badge",
            "slot": "side",
            "unlock_level": 4,
        },
        {
            "id": "pig_star_hat",
            "slot": "head",
            "unlock_level": 5,
        },
    ),
    "cat": (),
    "dog": (),
}


def get_pet_outfit_catalog(pet_type: str) -> tuple[dict, ...]:
    return PET_OUTFIT_CATALOG.get(pet_type, ())


def get_pet_outfit_item(pet_type: str, item_id: str) -> dict | None:
    return next(
        (item for item in get_pet_outfit_catalog(pet_type) if item["id"] == item_id),
        None,
    )


def merge_unlocked_outfit_ids(
    pet_type: str,
    level: int,
    current_ids: list[str] | None = None,
) -> list[str]:
    catalog = get_pet_outfit_catalog(pet_type)
    known_ids = {item["id"] for item in catalog}
    unlocked_ids = {
        item_id
        for item_id in (current_ids or [])
        if item_id in known_ids
    }
    unlocked_ids.update(
        item["id"]
        for item in catalog
        if item["unlock_level"] <= level
    )
    return [item["id"] for item in catalog if item["id"] in unlocked_ids]


def normalize_equipped_outfits(
    pet_type: str,
    unlocked_ids: list[str],
    equipped_outfits: dict[str, str] | None,
) -> dict[str, str]:
    unlocked = set(unlocked_ids)
    normalized = {}
    for slot, item_id in (equipped_outfits or {}).items():
        item = get_pet_outfit_item(pet_type, item_id)
        if (
            slot in OUTFIT_SLOTS
            and item is not None
            and item["slot"] == slot
            and item_id in unlocked
        ):
            normalized[slot] = item_id
    return normalized


def build_pet_outfit_state(
    pet_type: str,
    level: int,
    unlocked_ids: list[str] | None,
    equipped_outfits: dict[str, str] | None,
) -> dict:
    normalized_unlocked = merge_unlocked_outfit_ids(
        pet_type,
        level,
        unlocked_ids,
    )
    return {
        "unlocked_outfit_ids": normalized_unlocked,
        "equipped_outfits": normalize_equipped_outfits(
            pet_type,
            normalized_unlocked,
            equipped_outfits,
        ),
    }
