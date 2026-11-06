# Voz por proximidade

Cada sala do hotel é um canal de voz LiveKit (`habbo:<roomId>`). O volume de cada pessoa depende da
distância em tiles entre os avatares, calculada **no browser** a partir das posições que o Nitro já conhece.

> Escopo: hotel fechado entre amigos. O cliente é confiável quanto à sala em que está. Não há
> validação autoritativa de sala no servidor (nenhum plugin no Arcturus).

## Arquitetura

```
 browser (nitro-react)                         servidor
 ┌──────────────────────────────┐   GET /voice-token?room=N    ┌───────────────┐
 │ useProximityVoice            │ ── Authorization: Bearer vp ─▶│ voice-sidecar │  HMAC(vp) ✔
 │  ├ RoomEngineEvent.INITIALIZED│ ◀── { token (15 min), url } ──│ :8090         │  JWT LiveKit
 │  │  / DISPOSED → sala atual   │                              └───────────────┘
 │  ├ ProximityVoiceClient       │   wss signaling              ┌───────────────┐
 │  │  1 Room por vez            │ ────────────────────────────▶│ livekit :7880 │
 │  │  tick 200 ms:              │   mídia UDP 7882 / TCP 7881  │  SFU          │
 │  │   posições → proximity.ts  │ ◀═══════════════════════════▶│  TURN 3478/udp│
 │  │   setSubscribed / setVolume│                              └───────────────┘
 │  └ VoiceWidgetView (UI)       │
 └──────────────────────────────┘
```

- **identity** do LiveKit = `users.id` do Arcturus. **room** = `habbo:<roomId>`.
- Token: TTL 15 min, só `habbo:<room>`, `canPublish`, `canSubscribe`, `canPublishData: false`,
  fontes limitadas a `microphone`. O LiveKit renova o token da sessão sozinho; os 15 min só valem para o join.
- O cliente conecta com `autoSubscribe: false` e assina só quem está perto:
  - assina a ≤ 8 tiles, desassina a > 9 (histerese), no máximo os 10 mais próximos;
  - `gain = (1 - d/8)²`, aplicado com `RemoteAudioTrack.setVolume`. Entre 8 e 9 tiles fica assinado mas mudo;
  - pan estéreo pelo dx isométrico (`StereoPannerNode`);
  - `occlusionFactor(a, b) => 1` é o ponto de extensão para oclusão por parede (fase 2).

### Arquivos

`nitro/nitro-react/` é uma cópia embutida (pasta comum, não submódulo) de `billsonnn/nitro-react@81702e1a` com a voz aplicada.
Para trazer mudanças do upstream, faça diff contra esse commit.

| Onde | O quê |
|---|---|
| `livekit/livekit.yaml` | config do SFU (portas, TURN) |
| `voice-sidecar/` | Fastify + zod + livekit-server-sdk; `npm test` |
| `nitro/nitro-react/src/api/voice/VoiceConfig.ts` | **todas as constantes** (raio, histerese, MAX_SUBS, tick, PTT) |
| `nitro/nitro-react/src/api/voice/proximity.ts` | lógica pura (ranking, histerese, gain, pan) + testes |
| `nitro/nitro-react/src/api/voice/ProximityVoiceClient.ts` | ponte com o LiveKit, corridas, mic |
| `nitro/nitro-react/src/api/voice/GetVoicePositionSnapshot.ts` | posições via `getRoomObjects(UNIT)` + `userDataManager` |
| `nitro/nitro-react/src/hooks/voice/useProximityVoice.ts` | hook (eventos de sala, PTT, estado) |
| `nitro/nitro-react/src/components/room/widgets/voice/` | UI (mic, PTT, "falando", erros) |
| `nitro/configuration/nitro-react/public/ui-config.json` → `"voice"` | overrides em runtime, incluindo `sidecarUrl` |

## Autenticação: o voice pass

O `auth_ticket` do Arcturus não é reutilizado. Cada amigo recebe um link com um **voice pass**:

```
http://hotel/?sso=<auth_ticket>&vp=<userId>.<expiraEm>.<HMAC-SHA256(VOICE_AUTH_SECRET, "v1.<userId>.<expiraEm>")>
```

- O cliente lê `vp`, guarda em `sessionStorage`, remove da barra de endereço e envia como `Authorization: Bearer`.
- O sidecar verifica a assinatura (comparação em tempo constante) e a expiração. A `identity` do token sai do pass.
- O cliente recusa conectar se o `userId` do pass for diferente do usuário logado no Nitro (pega link trocado; não é segurança).
- **Revogação:** só por expiração ou rotação do `VOICE_AUTH_SECRET`, o que invalida todos os passes.

Gerar o link de um amigo:

```bash
cd voice-sidecar && npm ci
```

```bash
set -a && . ../.env && set +a && npm run mint-link -- --user 2 --days 30 --sso SEU_TICKET
```

## Variáveis de ambiente (`.env`, a partir de `.env.example`)

| Variável | Uso |
|---|---|
| `LK_KEY` / `LK_SECRET` | par de API do LiveKit (secret ≥ 32 chars). `docker run --rm livekit/livekit-server:v1.13.10 generate-keys` |
| `LK_PUBLIC_URL` | URL de signaling vista pelo **browser**: `ws://127.0.0.1:7880` em dev, `wss://voice.example.com` em prod |
| `LK_NODE_IP` | IP anunciado nos candidatos ICE: `127.0.0.1` em dev, IP público em prod |
| `LK_TURN_ENABLED` / `LK_TURN_DOMAIN` | TURN embutido (desligado por padrão) |
| `VOICE_AUTH_SECRET` | segredo HMAC dos voice passes (≥ 32 chars). `openssl rand -base64 48` |
| `NITRO_ORIGIN` | origem(ns) exata(s) do Nitro, separadas por vírgula, para o CORS do sidecar |
| `NITRO_PUBLIC_URL` | base dos links gerados pelo `mint-link` |

O compose falha na hora, com mensagem clara, se alguma variável obrigatória faltar.

## Portas

| Porta | Proto | Quem | Passa pelo Caddy? |
|---|---|---|---|
| 7880 | TCP | signaling LiveKit (ws/wss) | sim (`voice.example.com`) |
| **7881** | TCP | mídia ICE/TCP (fallback) | **não**, abrir no firewall |
| **7882** | UDP | mídia (UDP mux, porta única) | **não**, abrir no firewall |
| **3478** | UDP | TURN embutido (se ligado) | **não**, abrir no firewall |
| 8090 | TCP | voice-sidecar | sim (`/voice-api`) |

## HTTPS é obrigatório fora de localhost

Browsers só liberam o microfone em contexto seguro (`https://` ou `http://localhost`/`127.0.0.1`).
Sem HTTPS a voz entra em **modo só-ouvindo** e o widget mostra "Sem HTTPS". Para produção, use
`caddy/Caddyfile.example`: ele faz o TLS do Nitro, assets, swf, wss do Arcturus, sidecar (`/voice-api`) e LiveKit.
Depois de ligar o HTTPS, troque também `socket.url`/`asset.url` no `renderer-config.json` e
`voice.sidecarUrl` no `ui-config.json`. Conteúdo misto (página https chamando ws://) é bloqueado.

TURN só é necessário para amigos atrás de NAT/firewall restritivo (rede corporativa, alguns 4G). Para ligar:
`LK_TURN_ENABLED=true`, `LK_TURN_DOMAIN=turn.example.com` (DNS apontando para o servidor) e abrir 3478/udp.
TURN/TLS (5349) exige certificado: veja os comentários em `livekit/livekit.yaml`.

## Testar localmente

1. `cp .env.example .env` e troque os segredos.
2. `just install` (submódulos) e depois `docker compose up`.
3. Crie um segundo usuário (opcional, só dev):

   ```bash
   docker exec -i mysql mariadb -uroot -parcturus_root_pw arcturus < mysql/dev/voice_second_user.sql
   ```

4. Gere um pass para cada usuário (`--user 1 --sso 123` e `--user <id do VoiceTester> --sso 456`).
5. Abra cada link num **browser ou perfil diferente**. A mesma identity em duas abas derruba a primeira (`DUPLICATE_IDENTITY`).
6. Entre os dois na mesma sala e afaste os avatares: o volume cai e some além de ~8–9 tiles. Troque de sala:
   ninguém de outra sala é ouvido.

Testes automatizados:

```bash
cd voice-sidecar && npm test
```

```bash
cd nitro/nitro-react && yarn test
```

## Push-to-talk e o chat do Nitro

O Nitro foca o input do chat em **qualquer** tecla. Por isso a tecla de PTT (padrão `V`, configurável em
`voice.pushToTalkKey`, como `KeyboardEvent.code`) só funciona como PTT **enquanto o input do chat está vazio**.
Com texto digitado, ela escreve normalmente. Consequência: com PTT ligado não dá para começar uma mensagem com
"v". Se isso incomodar, use uma tecla que não digita nada, como `"Backquote"` ou `"F2"`. O PTT vem desligado por
padrão; o modo normal é microfone aberto com botão de mudo.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| "Falha ao conectar na voz" | `LK_PUBLIC_URL` errado, 7880 inacessível, ou ws:// numa página https |
| Conecta, mas ninguém se ouve | 7882/udp e 7881/tcp fechados, ou `LK_NODE_IP` errado. Ligue o TURN |
| Mic aparece riscado / "Microfone indisponível" após ~10 s | `livekit-server` **mais antigo** que o `livekit-client` (incompatibilidade de protocolo: o publish fica pendurado). Mantenha o server atualizado |
| "Ativar áudio" | política de autoplay do browser: clique no botão |
| "Voz desconectada" | mesmo usuário entrou em outro lugar, ou o servidor caiu |
