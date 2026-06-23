"""
Gera o players.json para o Draft Battle PvP a partir do jogadores_completos.json.

Lógica de força do jogador:
  - Agrega estatísticas das últimas 4 temporadas (2023-2026), por clube E seleção
  - Peso decrescente: 2026=1.0, 2025=0.6, 2024=0.35, 2023=0.2
  - Jogadores sem stats relevantes entram com valores baixos padrão (ainda jogáveis)
  - Goleiros usam métricas próprias (SAV, GC, CLS) — não GLS/AST/xG

Saída: data/players.json
"""
import json
from pathlib import Path

INPUT  = "jogadores_completos.json"
OUTPUT = Path("data/players.json")
OUTPUT.parent.mkdir(exist_ok=True)

YEAR_WEIGHTS = {"2026": 1.0, "2025": 0.6, "2024": 0.35, "2023": 0.2}

POS_ROLE = {
    "GK": "GK",
    "DC": "DEF", "DL": "DEF", "DR": "DEF",
    "DM": "MID", "MC": "MID", "ML": "MID", "MR": "MID", "AM": "MID",
    "ST": "FWD", "LW": "FWD", "RW": "FWD",
}
GEN_ROLE = {"G": "GK", "D": "DEF", "M": "MID", "F": "FWD"}

# Campos que somamos (contagens) vs que tiramos média ponderada (percentuais/rating)
SUM_FIELDS = [
    "MP","MIN","GLS","AST","TOS","SOT","BCM","KEYP","BCC","SDR",
    "APS","ALB","ACR","CLS","YC","RC","ELTG","DRP","TACK","INT",
    "BLS","ADW","GI","GC","SAV",
]
FLOAT_SUM_FIELDS = ["xG","xA","xGI"]
AVG_FIELDS = ["APS%","LBA%","CA%","ASR"]  # média ponderada por peso (não por MP, simplicidade)


def get_role(j):
    for p in (j.get("posicoes_detalhadas") or []):
        if p in POS_ROLE:
            return POS_ROLE[p]
    return GEN_ROLE.get(j.get("posicao", ""), "MID")


def normalize_year(y):
    """Normaliza ano tipo '24/25' -> '2025' (usa o ano final da temporada europeia)."""
    y = str(y)
    if "/" in y:
        return "20" + y.split("/")[1]
    return y


def aggregate_stats(jogador):
    """
    Agrega estatísticas de clube + seleção das últimas 4 temporadas,
    aplicando peso decrescente por ano.
    """
    all_entries = (jogador.get("estatisticas_clube") or []) + (jogador.get("estatisticas_selecao") or [])

    weighted_sum   = {f: 0.0 for f in SUM_FIELDS + FLOAT_SUM_FIELDS}
    weighted_avg_n = {f: 0.0 for f in AVG_FIELDS}   # soma ponderada
    weighted_avg_d = {f: 0.0 for f in AVG_FIELDS}   # soma dos pesos usados
    total_weight_used = 0.0
    seasons_used = 0

    for entry in all_entries:
        year = normalize_year(entry.get("ano"))
        weight = YEAR_WEIGHTS.get(year)
        if weight is None:
            continue  # fora do intervalo 2023-2026

        stats = entry.get("estatisticas", {})
        if not stats:
            continue

        seasons_used += 1
        total_weight_used += weight

        for f in SUM_FIELDS + FLOAT_SUM_FIELDS:
            v = stats.get(f)
            if isinstance(v, (int, float)):
                weighted_sum[f] += v * weight

        for f in AVG_FIELDS:
            v = stats.get(f)
            if isinstance(v, (int, float)):
                weighted_avg_n[f] += v * weight
                weighted_avg_d[f] += weight

    result = dict(weighted_sum)
    for f in AVG_FIELDS:
        result[f] = round(weighted_avg_n[f] / weighted_avg_d[f], 2) if weighted_avg_d[f] > 0 else None

    result["_seasons_used"] = seasons_used
    result["_weight_used"]  = round(total_weight_used, 2)
    return result


def compute_power(role, stats, seasons_used):
    """
    Calcula um score de 'poder' (0-100) usado pelo motor de simulação.
    Cada posição usa métricas diferentes.
    Jogadores sem dados (seasons_used==0) recebem poder mínimo (15).
    """
    if seasons_used == 0:
        return 15.0

    asr = stats.get("ASR") or 6.3
    base = (asr - 5.5) * 18   # ASR 6.3->14, 7.5->36, 8.0->45

    if role == "GK":
        sav = stats.get("SAV", 0)
        gc  = stats.get("GC", 1) or 1
        cls = stats.get("CLS", 0)
        mp  = stats.get("MP", 1) or 1
        save_ratio = sav / (sav + gc) if (sav + gc) > 0 else 0.6
        score = base + save_ratio * 30 + (cls / mp) * 25
    elif role == "DEF":
        tack = stats.get("TACK", 0)
        intc = stats.get("INT", 0)
        cls  = stats.get("CLS", 0)
        mp   = stats.get("MP", 1) or 1
        score = base + ((tack + intc) / mp) * 6 + (cls / mp) * 15
    elif role == "MID":
        ast  = stats.get("AST", 0)
        keyp = stats.get("KEYP", 0)
        aps_pct = stats.get("APS%") or 65
        tack = stats.get("TACK", 0)
        mp   = stats.get("MP", 1) or 1
        score = base + (ast / mp) * 20 + (keyp / mp) * 4 + (aps_pct - 60) * 0.3 + (tack / mp) * 2
    else:  # FWD
        gls = stats.get("GLS", 0)
        xgi = stats.get("xGI", 0)
        ast = stats.get("AST", 0)
        mp  = stats.get("MP", 1) or 1
        score = base + (gls / mp) * 28 + (xgi / mp) * 10 + (ast / mp) * 10

    return round(max(15, min(99, score)), 1)


def main():
    with open(INPUT, encoding="utf-8") as f:
        jogadores = json.load(f)

    players = []
    skipped_no_value = 0

    for j in jogadores:
        valor = j.get("valor_mercado_eur") or 0
        if valor < 50_000:
            # Sem valor cadastrado — atribui valor mínimo simbólico para entrar no draft
            valor = 300_000
            skipped_no_value += 1

        role = get_role(j)
        agg  = aggregate_stats(j)
        seasons_used = agg.pop("_seasons_used")
        weight_used  = agg.pop("_weight_used")
        power = compute_power(role, agg, seasons_used)

        players.append({
            "id":        j["id"],
            "nome":      j.get("nome_curto") or j["nome"],
            "nome_completo": j["nome"],
            "clube":     j.get("clube_atual") or j.get("time_nome", ""),
            "nac":       j.get("nacionalidade", ""),
            "posicao":   role,
            "pos_det":   (j.get("posicoes_detalhadas") or [""])[0],
            "altura":    j.get("altura_cm") or 0,
            "valor":     valor,
            "power":     power,
            "seasons":   seasons_used,
            # Stats agregadas resumidas (exibição no card)
            "mp":   round(agg.get("MP", 0) / max(weight_used, 0.01) * (seasons_used or 1) / max(seasons_used,1), 1) if seasons_used else 0,
            "gls":  round(agg.get("GLS", 0), 1),
            "ast":  round(agg.get("AST", 0), 1),
            "asr":  agg.get("ASR"),
            "sav":  round(agg.get("SAV", 0), 1),
            "gc":   round(agg.get("GC", 0), 1),
            "cls":  round(agg.get("CLS", 0), 1),
            "tack": round(agg.get("TACK", 0), 1),
            "intc": round(agg.get("INT", 0), 1),
            "apspct": agg.get("APS%"),
        })

    players.sort(key=lambda x: -x["valor"])

    counts = {r: sum(1 for p in players if p["posicao"] == r) for r in ["GK", "DEF", "MID", "FWD"]}
    print(f"Total jogadores: {len(players)}")
    print(f"Sem valor de mercado (valor mínimo aplicado): {skipped_no_value}")
    print(f"Por posição: {counts}")
    print(f"\nTop 5 por poder:")
    for p in sorted(players, key=lambda x: -x["power"])[:5]:
        print(f"  {p['nome']:<22} {p['clube']:<18} pwr={p['power']:<5} {p['posicao']} val={p['valor']/1e6:.1f}M")

    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(players, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = OUTPUT.stat().st_size / 1024
    print(f"\n✅ {OUTPUT} gerado → {len(players)} jogadores, {size_kb:.0f} KB")


if __name__ == "__main__":
    main()
