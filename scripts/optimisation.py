from functools import lru_cache
from itertools import combinations
from math import inf


def tup(x):
    return tuple(sorted(x))


def other_of_pair(pair, chosen):
    a, b = pair
    return b if a == chosen else a


class TeamPairingSolver:
    """
    M[i][j] = score attendu pour NOUS si notre codex i joue contre leur codex j.
    Les codex sont indexés de 0 à 7.
    """

    def __init__(self, matrix, our_names=None, their_names=None):
        self.M = matrix
        self.n = len(matrix)
        self.our_names = our_names or [f"our_{i}" for i in range(self.n)]
        self.their_names = their_names or [f"their_{i}" for i in range(self.n)]

    def name_our(self, i):
        return self.our_names[i]

    def name_their(self, j):
        return self.their_names[j]

    def matchup_score(self, our_idx, their_idx):
        return self.M[our_idx][their_idx]

    def _mask_from_indices(self, indices):
        mask = 0
        for idx in indices:
            mask |= 1 << idx
        return mask

    @lru_cache(maxsize=None)
    def _indices_from_mask(self, mask):
        return tuple(idx for idx in range(self.n) if mask & (1 << idx))

    @lru_cache(maxsize=None)
    def solve_value(self, ours_mask, theirs_mask):
        ours = self._indices_from_mask(ours_mask)
        theirs = self._indices_from_mask(theirs_mask)

        if len(ours) != len(theirs):
            raise ValueError("Les deux équipes doivent avoir le même nombre de codex restants.")

        if not ours:
            return 0.0

        if len(ours) == 4:
            return self.solve_round3_value(ours_mask, theirs_mask)

        best_def_value = -inf
        for our_def in ours:
            worst_vs_enemy_def = inf
            for their_def in theirs:
                value = self.solve_after_defenders_standard_value(ours_mask, theirs_mask, our_def, their_def)
                worst_vs_enemy_def = min(worst_vs_enemy_def, value)
            best_def_value = max(best_def_value, worst_vs_enemy_def)

        return best_def_value

    @lru_cache(maxsize=None)
    def solve_after_defenders_standard_value(self, ours_mask, theirs_mask, our_def, their_def):
        our_pool = self._indices_from_mask(ours_mask & ~(1 << our_def))
        their_pool = self._indices_from_mask(theirs_mask & ~(1 << their_def))

        best_attack_pair_value = -inf
        for our_attack_pair in combinations(our_pool, 2):
            worst_vs_enemy_attack_pair = inf
            our_attack_pair = tup(our_attack_pair)

            for their_attack_pair in combinations(their_pool, 2):
                value = self.solve_after_attackers_standard_value(
                    ours_mask,
                    theirs_mask,
                    our_def,
                    their_def,
                    our_attack_pair,
                    tup(their_attack_pair),
                )
                worst_vs_enemy_attack_pair = min(worst_vs_enemy_attack_pair, value)

            best_attack_pair_value = max(best_attack_pair_value, worst_vs_enemy_attack_pair)

        return best_attack_pair_value

    @lru_cache(maxsize=None)
    def solve_after_attackers_standard_value(self, ours_mask, theirs_mask, our_def, their_def, our_attack_pair, their_attack_pair):
        best_accept_value = -inf

        for accepted_enemy_attacker in their_attack_pair:
            worst_case_if_we_accept_this = inf

            for accepted_our_attacker in our_attack_pair:
                score_now = (
                    self.matchup_score(our_def, accepted_enemy_attacker)
                    + self.matchup_score(accepted_our_attacker, their_def)
                )
                next_ours_mask = ours_mask & ~(1 << our_def) & ~(1 << accepted_our_attacker)
                next_theirs_mask = theirs_mask & ~(1 << their_def) & ~(1 << accepted_enemy_attacker)
                total = score_now + self.solve_value(next_ours_mask, next_theirs_mask)
                worst_case_if_we_accept_this = min(worst_case_if_we_accept_this, total)

            best_accept_value = max(best_accept_value, worst_case_if_we_accept_this)

        return best_accept_value

    @lru_cache(maxsize=None)
    def solve_round3_value(self, ours_mask, theirs_mask):
        ours = self._indices_from_mask(ours_mask)
        theirs = self._indices_from_mask(theirs_mask)

        best_value = -inf
        for our_def in ours:
            worst_vs_their_def = inf
            for their_def in theirs:
                value = self.solve_after_defenders_round3_value(ours_mask, theirs_mask, our_def, their_def)
                worst_vs_their_def = min(worst_vs_their_def, value)
            best_value = max(best_value, worst_vs_their_def)

        return best_value

    @lru_cache(maxsize=None)
    def solve_after_defenders_round3_value(self, ours_mask, theirs_mask, our_def, their_def):
        our_pool = self._indices_from_mask(ours_mask & ~(1 << our_def))
        their_pool = self._indices_from_mask(theirs_mask & ~(1 << their_def))

        best_attack_pair_value = -inf
        for our_attack_pair in combinations(our_pool, 2):
            worst_vs_enemy_attack_pair = inf
            our_attack_pair = tup(our_attack_pair)

            for their_attack_pair in combinations(their_pool, 2):
                value = self.solve_after_attackers_round3_value(
                    ours_mask,
                    theirs_mask,
                    our_def,
                    their_def,
                    our_attack_pair,
                    tup(their_attack_pair),
                )
                worst_vs_enemy_attack_pair = min(worst_vs_enemy_attack_pair, value)

            best_attack_pair_value = max(best_attack_pair_value, worst_vs_enemy_attack_pair)

        return best_attack_pair_value

    @lru_cache(maxsize=None)
    def solve_after_attackers_round3_value(self, ours_mask, theirs_mask, our_def, their_def, our_attack_pair, their_attack_pair):
        ours = self._indices_from_mask(ours_mask)
        theirs = self._indices_from_mask(theirs_mask)
        our_forgotten = next(x for x in ours if x != our_def and x not in our_attack_pair)
        their_forgotten = next(x for x in theirs if x != their_def and x not in their_attack_pair)

        best_value = -inf
        for accepted_enemy_attacker in their_attack_pair:
            refused_enemy_attacker = other_of_pair(their_attack_pair, accepted_enemy_attacker)
            worst_case = inf

            for accepted_our_attacker in our_attack_pair:
                refused_our_attacker = other_of_pair(our_attack_pair, accepted_our_attacker)
                total = (
                    self.matchup_score(our_def, accepted_enemy_attacker)
                    + self.matchup_score(accepted_our_attacker, their_def)
                    + self.matchup_score(refused_our_attacker, refused_enemy_attacker)
                    + self.matchup_score(our_forgotten, their_forgotten)
                )
                worst_case = min(worst_case, total)

            best_value = max(best_value, worst_case)

        return best_value

    @lru_cache(maxsize=None)
    def solve_state(self, ours, theirs):
        """
        Retourne:
        {
            "value": score garanti / conservateur,
            "best_defender": meilleur défenseur à poser maintenant,
            "by_enemy_defender": {
                enemy_def: {
                    "value": ...,
                    "best_attack_pair": (...),
                    "by_enemy_attack_pair": {
                        (a,b): {
                            "value": ...,
                            "best_accept": enemy_attacker_to_accept,
                            "best_accept_value": ...,
                        }
                    }
                }
            }
        }
        """
        ours = tup(ours)
        theirs = tup(theirs)

        if len(ours) != len(theirs):
            raise ValueError("Les deux équipes doivent avoir le même nombre de codex restants.")

        if len(ours) == 0:
            return {"value": 0}

        summary = self.recommend_defender(ours, theirs)
        best_def = summary["best_defender"]
        ours_mask = self._mask_from_indices(ours)
        theirs_mask = self._mask_from_indices(theirs)

        if len(ours) == 4:
            best_def_detail = {
                their_def: self.solve_after_defenders_round3(ours, theirs, best_def, their_def)
                for their_def in theirs
            }
            return {
                "value": self.solve_value(ours_mask, theirs_mask),
                "best_defender": best_def,
                "by_enemy_defender": best_def_detail,
            }

        best_def_detail = {
            their_def: self.solve_after_defenders_standard(ours, theirs, best_def, their_def)
            for their_def in theirs
        }

        return {
            "value": self.solve_value(ours_mask, theirs_mask),
            "best_defender": best_def,
            "by_enemy_defender": best_def_detail,
        }

    @lru_cache(maxsize=None)
    def recommend_defender(self, ours, theirs):
        ours = tup(ours)
        theirs = tup(theirs)

        if len(ours) != len(theirs):
            raise ValueError("Les deux équipes doivent avoir le même nombre de codex restants.")

        if not ours:
            return {"value": 0.0, "best_defender": None}

        ours_mask = self._mask_from_indices(ours)
        theirs_mask = self._mask_from_indices(theirs)

        best_def = None
        best_def_value = -inf
        value_fn = (
            self.solve_after_defenders_round3_value
            if len(ours) == 4
            else self.solve_after_defenders_standard_value
        )

        for our_def in ours:
            worst_vs_enemy_def = inf
            for their_def in theirs:
                value = value_fn(ours_mask, theirs_mask, our_def, their_def)
                worst_vs_enemy_def = min(worst_vs_enemy_def, value)

            if worst_vs_enemy_def > best_def_value:
                best_def_value = worst_vs_enemy_def
                best_def = our_def

        return {
            "value": self.solve_value(ours_mask, theirs_mask),
            "best_defender": best_def,
        }

    @lru_cache(maxsize=None)
    def solve_after_defenders_standard(self, ours, theirs, our_def, their_def):
        """
        On connaît les 2 défenseurs.
        On choisit notre paire d'attaque contre leur défense.
        Eux choisissent leur paire d'attaque contre notre défense.
        Ensuite chaque défense choisit quel attaquant accepter.
        """
        ours_mask = self._mask_from_indices(ours)
        theirs_mask = self._mask_from_indices(theirs)
        our_pool = tuple(x for x in ours if x != our_def)
        their_pool = tuple(x for x in theirs if x != their_def)

        best_attack_pair = None
        best_attack_pair_value = -inf

        for our_attack_pair in combinations(our_pool, 2):
            worst_vs_enemy_attack_pair = inf
            our_attack_pair = tup(our_attack_pair)

            for their_attack_pair in combinations(their_pool, 2):
                value = self.solve_after_attackers_standard_value(
                    ours_mask,
                    theirs_mask,
                    our_def,
                    their_def,
                    our_attack_pair,
                    tup(their_attack_pair),
                )
                worst_vs_enemy_attack_pair = min(worst_vs_enemy_attack_pair, value)

            if worst_vs_enemy_attack_pair > best_attack_pair_value:
                best_attack_pair_value = worst_vs_enemy_attack_pair
                best_attack_pair = our_attack_pair

        detail_by_enemy_attack_pair = {}
        for their_attack_pair in combinations(their_pool, 2):
            their_attack_pair = tup(their_attack_pair)
            detail_by_enemy_attack_pair[their_attack_pair] = self.solve_after_attackers_standard(
                ours,
                theirs,
                our_def,
                their_def,
                best_attack_pair,
                their_attack_pair,
            )

        return {
            "value": best_attack_pair_value,
            "best_attack_pair": best_attack_pair,
            "by_enemy_attack_pair": detail_by_enemy_attack_pair,
        }

    @lru_cache(maxsize=None)
    def solve_after_attackers_standard(self, ours, theirs, our_def, their_def, our_attack_pair, their_attack_pair):
        """
        Nous choisissons quel attaquant adverse notre défense accepte.
        L'adversaire choisit quel de nos 2 attaquants sa défense accepte.
        Le refusé de chaque côté revient en main.
        Puis on recurse.
        """
        ours_mask = self._mask_from_indices(ours)
        theirs_mask = self._mask_from_indices(theirs)
        best_accept = None
        best_accept_value = -inf
        best_enemy_accept = None

        for accepted_enemy_attacker in their_attack_pair:
            worst_case_if_we_accept_this = inf
            chosen_by_enemy = None

            for accepted_our_attacker in our_attack_pair:
                score_now = (
                    self.matchup_score(our_def, accepted_enemy_attacker) +
                    self.matchup_score(accepted_our_attacker, their_def)
                )

                next_ours_mask = ours_mask & ~(1 << our_def) & ~(1 << accepted_our_attacker)
                next_theirs_mask = theirs_mask & ~(1 << their_def) & ~(1 << accepted_enemy_attacker)
                future = self.solve_value(next_ours_mask, next_theirs_mask)
                total = score_now + future

                if total < worst_case_if_we_accept_this:
                    worst_case_if_we_accept_this = total
                    chosen_by_enemy = accepted_our_attacker

            if worst_case_if_we_accept_this > best_accept_value:
                best_accept_value = worst_case_if_we_accept_this
                best_accept = accepted_enemy_attacker
                best_enemy_accept = chosen_by_enemy

        return {
            "value": best_accept_value,
            "best_accept": best_accept,               # qui nous acceptons sur notre défense
            "enemy_best_accept": best_enemy_accept,  # qui ils accepteraient sur leur défense
        }

    @lru_cache(maxsize=None)
    def solve_round3(self, ours, theirs):
        """
        Round spécial à 4 joueurs restants.
        On pose 1 défense de chaque côté, on propose 2 attaquants, on choisit,
        puis:
          - refusé vs refusé
          - oublié vs oublié
        """
        ours_mask = self._mask_from_indices(ours)
        theirs_mask = self._mask_from_indices(theirs)
        best_def = self.recommend_defender(ours, theirs)["best_defender"]
        best_detail = {
            their_def: self.solve_after_defenders_round3(ours, theirs, best_def, their_def)
            for their_def in theirs
        }

        return {
            "value": self.solve_value(ours_mask, theirs_mask),
            "best_defender": best_def,
            "by_enemy_defender": best_detail,
        }

    @lru_cache(maxsize=None)
    def solve_after_defenders_round3(self, ours, theirs, our_def, their_def):
        ours_mask = self._mask_from_indices(ours)
        theirs_mask = self._mask_from_indices(theirs)
        our_pool = tuple(x for x in ours if x != our_def)
        their_pool = tuple(x for x in theirs if x != their_def)

        best_attack_pair = None
        best_attack_pair_value = -inf

        for our_attack_pair in combinations(our_pool, 2):
            worst_vs_enemy_attack_pair = inf
            our_attack_pair = tup(our_attack_pair)

            for their_attack_pair in combinations(their_pool, 2):
                value = self.solve_after_attackers_round3_value(
                    ours_mask,
                    theirs_mask,
                    our_def,
                    their_def,
                    our_attack_pair,
                    tup(their_attack_pair),
                )
                worst_vs_enemy_attack_pair = min(worst_vs_enemy_attack_pair, value)

            if worst_vs_enemy_attack_pair > best_attack_pair_value:
                best_attack_pair_value = worst_vs_enemy_attack_pair
                best_attack_pair = our_attack_pair

        best_details = {}
        for their_attack_pair in combinations(their_pool, 2):
            their_attack_pair = tup(their_attack_pair)
            best_details[their_attack_pair] = self.solve_after_attackers_round3(
                ours,
                theirs,
                our_def,
                their_def,
                best_attack_pair,
                their_attack_pair,
            )

        return {
            "value": best_attack_pair_value,
            "best_attack_pair": best_attack_pair,
            "by_enemy_attack_pair": best_details,
        }

    @lru_cache(maxsize=None)
    def solve_after_attackers_round3(self, ours, theirs, our_def, their_def, our_attack_pair, their_attack_pair):
        best_accept = None
        best_value = -inf
        best_enemy_accept = None

        our_forgotten = next(x for x in ours if x != our_def and x not in our_attack_pair)
        their_forgotten = next(x for x in theirs if x != their_def and x not in their_attack_pair)

        for accepted_enemy_attacker in their_attack_pair:
            refused_enemy_attacker = other_of_pair(their_attack_pair, accepted_enemy_attacker)

            worst_case = inf
            enemy_accept_choice = None

            for accepted_our_attacker in our_attack_pair:
                refused_our_attacker = other_of_pair(our_attack_pair, accepted_our_attacker)

                total = 0
                # Notre défense contre leur attaquant choisi
                total += self.matchup_score(our_def, accepted_enemy_attacker)
                # Notre attaquant choisi par eux contre leur défense
                total += self.matchup_score(accepted_our_attacker, their_def)
                # Refusé vs refusé
                total += self.matchup_score(refused_our_attacker, refused_enemy_attacker)
                # Oublié vs oublié
                total += self.matchup_score(our_forgotten, their_forgotten)

                if total < worst_case:
                    worst_case = total
                    enemy_accept_choice = accepted_our_attacker

            if worst_case > best_value:
                best_value = worst_case
                best_accept = accepted_enemy_attacker
                best_enemy_accept = enemy_accept_choice

        return {
            "value": best_value,
            "best_accept": best_accept,
            "enemy_best_accept": best_enemy_accept,
            "our_forgotten": our_forgotten,
            "their_forgotten": their_forgotten,
        }

    def print_plan(self, result, ours, theirs, indent=0):
        pad = " " * indent
        if len(ours) == 0:
            print(pad + f"Score final estimé: {result['value']}")
            return

        our_def = result["best_defender"]
        print(pad + f"Meilleure défense à poser: {self.name_our(our_def)}")
        print(pad + f"Score garanti estimé depuis cet état: {result['value']:.2f}")

        for their_def, detail in result["by_enemy_defender"].items():
            print(pad + f"  Si l'adversaire défend avec {self.name_their(their_def)} :")
            print(pad + f"    -> meilleure paire d'attaque à proposer: "
                  f"{[self.name_our(x) for x in detail['best_attack_pair']]}")
            print(pad + f"    -> valeur estimée: {detail['value']:.2f}")

            for enemy_attack_pair, d2 in detail["by_enemy_attack_pair"].items():
                print(pad + f"      S'ils proposent {[self.name_their(x) for x in enemy_attack_pair]} "
                      f"sur notre défense :")
                print(pad + f"        -> on accepte: {self.name_their(d2['best_accept'])}")
                print(pad + f"        -> ils accepteraient chez eux: {self.name_our(d2['enemy_best_accept'])}")
                print(pad + f"        -> score estimé: {d2['value']:.2f}")


if __name__ == "__main__":
    # Exemple fictif 8x8
    M = [
        [10, 12,  8, 15,  7, 13,  9, 11],
        [14, 10, 13,  9, 12,  8, 15, 11],
        [ 8, 11, 10, 13, 14,  9, 12,  7],
        [12,  9, 15, 10, 11, 14,  8, 13],
        [ 7, 13, 12, 11, 10, 15,  9, 14],
        [13,  8,  9, 14, 15, 10, 11, 12],
        [11, 15, 14,  8,  9, 12, 10, 13],
        [ 9, 11,  7, 12, 13, 14, 15, 10],
    ]

    our_names = [
        "Chaos Knights",
        "Aeldari",
        "World Eaters",
        "Astra Militarum",
        "Dark Angels",
        "Necrons",
        "Orks",
        "Tyranids",
    ]

    their_names = [
        "Custodes",
        "Drukhari",
        "T'au",
        "CSM",
        "Grey Knights",
        "Sisters",
        "Death Guard",
        "Black Templars",
    ]

    solver = TeamPairingSolver(M, our_names, their_names)
    result = solver.solve_state(tuple(range(8)), tuple(range(8)))
    solver.print_plan(result, tuple(range(8)), tuple(range(8)))
