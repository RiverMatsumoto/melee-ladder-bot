function expected(ra, rb) {
    return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}
function clamp1000(x) {
    return Math.max(0, Math.min(1000, x));
}
/**
 * Standard Elo expectation; actual score is W/(W+L) so 3-0 > 3-2.
 * K fixed to keep it simple.
 */
export function applyElo(winnerRating, loserRating, winnerGames, loserGames, k = 32) {
    const total = winnerGames + loserGames;
    if (total <= 0)
        throw new Error("invalid set score total");
    const Ea = expected(winnerRating, loserRating);
    const Sa = winnerGames / total;
    // initial delta
    let deltaWinner = Math.round(k * (Sa - Ea));
    // clamp winner; then force symmetry from actual clamp effect
    const winnerAfter = clamp1000(winnerRating + deltaWinner);
    deltaWinner = winnerAfter - winnerRating;
    let deltaLoser = -deltaWinner;
    let loserAfter = clamp1000(loserRating + deltaLoser);
    // if loser clamped, re-symmetrize based on loser's final delta
    deltaLoser = loserAfter - loserRating;
    deltaWinner = -deltaLoser;
    return {
        deltaWinner,
        deltaLoser,
        winnerAfter: clamp1000(winnerRating + deltaWinner),
        loserAfter,
    };
}
