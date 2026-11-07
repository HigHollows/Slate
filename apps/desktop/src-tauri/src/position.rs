//! Indices fractionnaires (chaînes triables) pour ordonner des frères sans réécrire les autres.
//! Insérer entre deux positions ne modifie jamais les voisins : indispensable à la synchronisation (Phase 7).
//! Alphabet en ordre ASCII : '0'..'9' < 'A'..'Z' < 'a'..'z' => l'ordre SQL (BINARY) = l'ordre logique.

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE: usize = DIGITS.len();

fn idx(c: u8) -> usize {
    DIGITS.iter().position(|d| *d == c).unwrap_or(0)
}

fn midpoint(a: &[u8], b: Option<&[u8]>) -> Vec<u8> {
    if let Some(b) = b {
        let mut n = 0;
        while n < b.len() && a.get(n).copied().unwrap_or(b'0') == b[n] {
            n += 1;
        }
        if n > 0 {
            let a_rest: &[u8] = if n <= a.len() { &a[n..] } else { &[] };
            let mut r = b[..n].to_vec();
            r.extend(midpoint(a_rest, Some(&b[n..])));
            return r;
        }
    }
    let da = a.first().map(|c| idx(*c)).unwrap_or(0);
    let db = b.and_then(|b| b.first()).map(|c| idx(*c)).unwrap_or(BASE);
    if db - da > 1 {
        return vec![DIGITS[(da + db).div_ceil(2)]];
    }
    if let Some(b) = b {
        if b.len() > 1 {
            return b[..1].to_vec();
        }
    }
    let mut r = vec![DIGITS[da]];
    r.extend(midpoint(if a.is_empty() { &[] } else { &a[1..] }, None));
    r
}

/// Partie entière : 8 chiffres base 62 (62^8 ≈ 2,2·10^14 positions) ; au-delà, partie fractionnaire.
/// Les ajouts en fin/début de liste incrémentent/décrémentent l'entier : les clés restent courtes quel que soit le volume
/// (l'ancienne méthode, purement fractionnaire, allongeait la clé d'un caractère tous les ~30 ajouts).
const INT_LEN: usize = 8;
const INT_MAX: u64 = 218_340_105_584_895; // 62^8 - 1

fn valid(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s.bytes().all(|c| DIGITS.contains(&c))
        && (s.len() <= INT_LEN || !s.ends_with('0'))
}

/// Entier (8 premiers caractères, complétés par des « 0 ») → u64.
fn int_of(s: &str) -> u64 {
    let b = s.as_bytes();
    (0..INT_LEN).fold(0u64, |acc, i| {
        acc * BASE as u64 + idx(b.get(i).copied().unwrap_or(b'0')) as u64
    })
}

fn int_to_key(mut n: u64) -> String {
    let mut out = [b'0'; INT_LEN];
    for i in (0..INT_LEN).rev() {
        out[i] = DIGITS[(n % BASE as u64) as usize];
        n /= BASE as u64;
    }
    String::from_utf8(out.to_vec()).expect("alphabet ASCII")
}

/// Partie fractionnaire d'une clé (au-delà des 8 premiers caractères ; vide pour une ancienne clé courte).
fn frac_of(k: &str) -> &[u8] {
    if k.len() > INT_LEN {
        &k.as_bytes()[INT_LEN..]
    } else {
        &[]
    }
}

fn with_frac(int: u64, frac: Vec<u8>) -> String {
    let mut k = int_to_key(int);
    k.push_str(&String::from_utf8(frac).expect("alphabet ASCII"));
    k
}

/// Position strictement comprise entre `a` et `b` (`None` = borne ouverte).
/// Une clé = entier de 8 chiffres base 62 + fraction éventuelle ; les anciennes clés courtes (Phase 3) sont lues
/// comme leur forme complétée par des « 0 » (fraction vide).
pub fn between(a: Option<&str>, b: Option<&str>) -> Result<String, String> {
    for k in [a, b].into_iter().flatten() {
        if !valid(k) {
            return Err(format!("position invalide : {k}"));
        }
    }
    if let (Some(a), Some(b)) = (a, b) {
        if a >= b {
            return Err(format!("positions non ordonnées : {a} >= {b}"));
        }
    }
    Ok(match (a, b) {
        (None, None) => int_to_key(INT_MAX / 2),
        (Some(a), None) => {
            let ia = int_of(a);
            if ia < INT_MAX {
                int_to_key(ia + 1)
            } else {
                with_frac(ia, midpoint(frac_of(a), None))
            }
        }
        (None, Some(b)) => {
            let ib = int_of(b);
            if ib > 0 {
                int_to_key(ib - 1)
            } else if frac_of(b).is_empty() {
                return Err("position minimale atteinte".into());
            } else {
                with_frac(0, midpoint(&[], Some(frac_of(b))))
            }
        }
        (Some(a), Some(b)) => {
            let (ia, ib) = (int_of(a), int_of(b));
            if ib > ia + 1 {
                int_to_key(ia + (ib - ia) / 2)
            } else if ib == ia + 1 {
                // Même entier que `a`, fraction au-dessus de celle de `a` : reste strictement avant `b`.
                with_frac(ia, midpoint(frac_of(a), None))
            } else if ia == ib {
                if frac_of(b).is_empty() {
                    return Err(format!("aucune position entre {a} et {b}"));
                }
                with_frac(ia, midpoint(frac_of(a), Some(frac_of(b))))
            } else {
                return Err(format!("positions non ordonnées : {a} >= {b}"));
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn premiere_position_et_bornes() {
        let p = between(None, None).unwrap();
        assert!(valid(&p));
        let after = between(Some(&p), None).unwrap();
        let before = between(None, Some(&p)).unwrap();
        assert!(before < p && p < after, "{before} < {p} < {after}");
    }

    #[test]
    fn refuse_les_entrees_invalides() {
        assert!(between(Some("b"), Some("a")).is_err());
        assert!(between(Some("a"), Some("a")).is_err());
        assert!(
            between(Some("abcdefghij0"), None).is_err(),
            "fraction se terminant par 0"
        );
        assert!(between(Some("é"), None).is_err());
    }

    /// Insertions pseudo-aléatoires : l'ordre reste strict et aucune clé n'est jamais modifiée.
    #[test]
    fn insertions_aleatoires_gardent_un_ordre_strict() {
        let mut seed: u64 = 0x2545F4914F6CDD1D;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut list: Vec<String> = Vec::new();
        for _ in 0..2000 {
            let i = (next() % (list.len() as u64 + 1)) as usize;
            let a = if i == 0 {
                None
            } else {
                Some(list[i - 1].as_str())
            };
            let b = list.get(i).map(|s| s.as_str());
            let p = between(a, b).unwrap();
            assert!(
                a.is_none_or(|a| a < p.as_str()) && b.is_none_or(|b| p.as_str() < b),
                "{a:?} < {p} < {b:?} violé"
            );
            list.insert(i, p);
        }
        assert!(list.windows(2).all(|w| w[0] < w[1]), "ordre strict violé");
        assert!(list.iter().all(|p| valid(p)));
    }

    #[test]
    fn ajouts_en_fin_et_en_debut_restent_courts_meme_apres_des_dizaines_de_milliers() {
        let mut last = between(None, None).unwrap();
        for _ in 0..50_000 {
            let next = between(Some(&last), None).unwrap();
            assert!(next > last);
            last = next;
        }
        assert_eq!(last.len(), 8);
        let mut first = between(None, None).unwrap();
        for _ in 0..50_000 {
            let prev = between(None, Some(&first)).unwrap();
            assert!(prev < first);
            first = prev;
        }
        assert_eq!(first.len(), 8);
    }

    #[test]
    fn cohabite_avec_les_anciennes_positions_courtes() {
        // Positions produites par la Phase 3 (« V », « k », « VV »…).
        let legacy = ["3", "V", "VV", "k", "w"];
        for w in legacy.windows(2) {
            assert!(w[0] < w[1]);
            let m = between(Some(w[0]), Some(w[1])).unwrap();
            assert!(
                w[0] < m.as_str() && m.as_str() < w[1],
                "{} < {m} < {}",
                w[0],
                w[1]
            );
        }
        let after = between(Some("w"), None).unwrap();
        assert!(after.as_str() > "w");
        let before = between(None, Some("3")).unwrap();
        assert!(before.as_str() < "3");
    }

    #[test]
    fn bornes_extremes_de_l_entier() {
        let max = "zzzzzzzz";
        let after = between(Some(max), None).unwrap();
        assert!(after.as_str() > max);
        let min = "00000001";
        let before = between(None, Some(min)).unwrap();
        assert!(before.as_str() < min);
        let zero = "00000000";
        let b0 = between(None, Some(zero));
        assert!(b0.is_err() || b0.as_deref().unwrap() < zero);
    }

    #[test]
    fn insertions_repetees_au_meme_endroit_restent_courtes() {
        let mut a = between(None, None).unwrap();
        let b = between(Some(&a), None).unwrap();
        for _ in 0..200 {
            a = between(Some(&a), Some(&b)).unwrap();
        }
        assert!(a.len() < 300);
    }
}
