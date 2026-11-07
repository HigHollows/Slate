use super::*;
use tempfile::tempdir;

fn png() -> Vec<u8> {
    let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    v.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R', 1, 2, 3]);
    v
}

#[test]
fn aller_retour_idempotent_et_adresse_par_contenu() {
    let d = tempdir().unwrap();
    let a = put(d.path(), &png()).unwrap();
    let b = put(d.path(), &png()).unwrap();
    assert_eq!(a.hash, b.hash);
    assert!(is_hash(&a.hash));
    assert_eq!(a.mime, "image/png");
    assert_eq!(
        fs::read_dir(d.path()).unwrap().count(),
        1,
        "pas de doublon ni de fichier temporaire"
    );
    let (bytes, mime) = get(d.path(), &a.hash).unwrap();
    assert_eq!(bytes, png());
    assert_eq!(mime, "image/png");
}

#[test]
fn le_type_vient_des_octets_et_svg_html_sont_refuses() {
    let d = tempdir().unwrap();
    assert!(put(
        d.path(),
        b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"
    )
    .is_err());
    assert!(put(d.path(), b"<html><script>alert(1)</script></html>").is_err());
    assert!(put(d.path(), b"MZ\x90\x00 programme").is_err());
    assert!(put(d.path(), &[]).is_err());
    for (bytes, mime) in [
        (vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 1], "image/jpeg"),
        (b"GIF89a....".to_vec(), "image/gif"),
        (b"RIFF\x00\x00\x00\x00WEBPVP8 ".to_vec(), "image/webp"),
    ] {
        assert_eq!(put(d.path(), &bytes).unwrap().mime, mime);
    }
}

#[test]
fn taille_bornee() {
    let d = tempdir().unwrap();
    let mut big = png();
    big.resize(MAX_BYTES + 1, 0);
    assert!(put(d.path(), &big).is_err());
    let mut ok = png();
    ok.resize(MAX_BYTES, 0);
    assert!(put(d.path(), &ok).is_ok());
}

#[test]
fn aucune_traversee_de_chemin_et_alteration_detectee() {
    let d = tempdir().unwrap();
    for bad in [
        "../x",
        "..",
        "",
        "a/b",
        &"A".repeat(64),
        &"g".repeat(64),
        &"a".repeat(63),
    ] {
        assert!(get(d.path(), bad).is_err(), "{bad}");
    }
    let s = put(d.path(), &png()).unwrap();
    assert!(matches!(
        get(d.path(), &"0".repeat(64)),
        Err(AppError::NotFound(_))
    ));
    fs::write(d.path().join(format!("{}.png", s.hash)), b"corrompu").unwrap();
    assert!(get(d.path(), &s.hash).is_err());
}
