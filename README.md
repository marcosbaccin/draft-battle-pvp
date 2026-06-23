# 🏆 Draft Battle PvP — Brasileirão 2026

Draft online em tempo real entre dois treinadores, usando dados reais de jogadores do Brasileirão 2026 coletados via scraping do Sofascore. Hospedado gratuitamente no GitHub Pages, sincronizado via Firebase Realtime Database.

---

## Como funciona

1. **Jogador 1** cria uma sala → recebe um código de 5 letras
2. **Jogador 2** entra com esse código (em outro navegador/celular)
3. Os dois fazem o **draft alternado** (snake draft, 11 picks): 1 GK, 4 DEF, 3 MID, 3 FWD, com orçamento de €150M
4. Uma **restrição diária** (igual para todos, baseada na data) limita as escolhas — ex: "apenas estrangeiros"
5. Ao final do draft, o motor de simulação calcula o placar usando o **Power** de cada jogador (derivado das estatísticas reais)
6. Resultado, MVP e times completos aparecem para os dois

---

## Configuração do Firebase (já feita)

O projeto já está configurado com as credenciais em `index.html`. Caso precise recriar:

1. [console.firebase.google.com](https://console.firebase.google.com) → criar projeto
2. **Build → Realtime Database → Criar banco de dados** → modo de teste
3. **Configurações do projeto → Seus apps → `</>` Web** → copiar o `firebaseConfig`
4. Colar no `<script type="module">` dentro do `index.html`

### Regra de segurança recomendada (ajustar depois do modo de teste expirar)

Em **Realtime Database → Regras**, cole:

```json
{
  "rules": {
    "rooms": {
      "$roomCode": {
        ".read": true,
        ".write": true,
        ".validate": "newData.hasChildren(['status','players','budgets','teams','pickIndex'])"
      }
    }
  }
}
```

Isso mantém o jogo público (sem necessidade de login) mas exige que qualquer escrita tenha a estrutura mínima esperada.

---

## Gerando a base de jogadores

```bash
python gerar_players_json.py
```

Requer `jogadores_completos.json` (gerado pelo scraper) na mesma pasta. Gera `data/players.json`.

### Lógica de cálculo do "Power"

Cada jogador tem suas estatísticas das **últimas 4 temporadas (2023-2026)** agregadas com peso decrescente:

| Ano | Peso |
|---|---|
| 2026 | 1.0 |
| 2025 | 0.6 |
| 2024 | 0.35 |
| 2023 | 0.2 |

Soma-se estatísticas de **clube e seleção** juntas. A partir dos dados agregados, calcula-se um `power` (0-99) com fórmulas específicas por posição:

- **GK:** taxa de defesas (`SAV`/`SAV+GC`) + jogos sem sofrer gol por partida
- **DEF:** desarmes + interceptações por jogo + jogos sem sofrer gol
- **MID:** assistências por jogo + passes-chave + % de acerto de passe
- **FWD:** gols por jogo + xGI por jogo + assistências por jogo

Todas as fórmulas usam o **ASR (rating médio ponderado)** como base, ajustado pelas métricas específicas da posição.

Jogadores sem estatísticas relevantes (lesionados, reservas, jogadores de base sem minutos) recebem **power mínimo de 15** — ainda jogáveis, mas claramente mais fracos.

---

## Estrutura do repositório

```
draft-battle-pvp/
├── index.html              # estrutura + config Firebase
├── game.js                 # toda a lógica do jogo e sincronização
├── gerar_players_json.py   # gera data/players.json a partir do scraper
├── README.md
└── data/
    └── players.json        # gerado pelo script acima
```

## Publicando no GitHub Pages

1. Cria um repositório no GitHub e sobe todos os arquivos (incluindo `data/players.json` já gerado)
2. **Settings → Pages → Branch: main → /(root)**
3. Acessa a URL gerada (`https://SEU_USUARIO.github.io/draft-battle-pvp/`) em dois navegadores/dispositivos diferentes para testar o PvP

---

## Detalhes técnicos da sincronização

- **Transações atômicas** (`runTransaction`) garantem que dois cliques simultâneos nunca deixem o mesmo jogador em dois times
- **Simulação determinística**: ambos os navegadores calculam o mesmo resultado a partir de uma seed compartilhada (`createdAt` da sala) — apenas o criador da sala (slot 0) salva o resultado oficial no Firebase, evitando gravações duplicadas
- **`onDisconnect`** limpa a vaga do jogador automaticamente se ele fechar a aba antes do rival entrar
- Salas não têm expiração automática no servidor (Realtime DB não tem TTL nativo) — ficam órfãs no banco mas não afetam novas partidas, já que cada uma usa um código único

---

## Limitações conhecidas

- Sem persistência de histórico de partidas (cada sala é descartável)
- Se o jogador que conduz a simulação (slot 0) perder conexão durante a animação, o resultado pode não ser salvo — nesse caso, recarregar a página reinicia o draft
- Não há reconexão automática após fechar o navegador no meio do draft (a sala ainda existe no Firebase, mas a página atual não tenta retomar a sessão)
