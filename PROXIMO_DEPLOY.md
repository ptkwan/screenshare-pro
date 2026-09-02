# Próximo Deploy — Backlog

Lista de coisas pra investigar/corrigir e subir tudo junto na próxima leva
(em vez de um build+release pra cada item). Vamos anotando aqui conforme
aparece, e só faz o ciclo de build/release quando decidirmos "bora subir".

Status: `[ ]` pendente · `[~]` investigando · `[x]` corrigido (mas ainda não deployado)

---

## [ ] 1. Compartilhar "Tela Cheia" com áudio do sistema não funciona

**Pedido:** arrumar igual o Discord faz (compartilha tela cheia + som do
sistema junto, sem precisar de dispositivo virtual).

**Contexto do que já existe:** hoje (`index.html`, função `startScreenShare`)
o áudio do sistema é capturado via `getUserMedia` com
`chromeMediaSource: 'desktop'` — é a API antiga/legada do Chromium, que é
conhecida por ser instável no Windows especificamente pra esse tipo de
captura. Pra compartilhamento de **janela específica** já existe um
workaround de verdade (captura nativa via `loopback-capture`, só o processo
daquela janela, ver `main.js` + `native/resolve-window-pid.ps1`) — mas pra
"Tela Cheia" o código ainda depende só da API antiga, que é exatamente onde
o problema deve estar.

**Hipótese pra investigar:** estender a captura nativa (WASAPI loopback) pra
cobrir o cenário de tela cheia também, em vez de depender da API legada do
Chromium — é basicamente o mesmo caminho que o Discord usa (captura nativa
do Windows, não a API do navegador).

---

## [ ] 2. Binonha não consegue compartilhar tela — CONFIRMADO: falta servidor TURN

Print mostrando o toast "Aguardando — Carregando tela de binonha..." que
não sai desse estado. A tela do Boa funciona normal pro mesmo grupo.

**Diagnóstico fechado**, via o log de ICE da v1.9.1 (conferido no painel do
Render):

```
Patrick: ICE (transmitindo pra Boa): connected       ✅
Patrick: ICE (transmitindo pra binonha): connected   ✅ (Patrick manda pra ele numa boa)
Patrick: ICE (assistindo binonha): checking → disconnected   ❌ (nunca conecta)
Patrick: ICE (assistindo Boa): connected             ✅
```

Padrão bem específico: **toda conexão em que o binonha é quem transmite
falha**, mesmo pra quem recebe de todo mundo normalmente. Bate exatamente
com a limitação já conhecida (STUN sem TURN) — a rede do binonha
especificamente não permite achar uma rota P2P direta quando ele é o lado
que envia vídeo, e sem servidor TURN não tem plano B.

**Correção:** configurar um servidor TURN (ex: Metered.ca, Cloudflare
Realtime, Twilio, ou self-host coturn) e adicionar no `iceServers` do
`config` em `index.html`, junto do STUN que já existe. Precisa criar conta
no serviço escolhido e ter as credenciais (usuário/senha ou API key) antes
de implementar.

---

## [ ] 2b. Conexão do Boa cai e reconecta em loop (`transport error`/`transport close`)

Log mostra o socket do Boa desconectando e reconectando repetidamente
(`Cliente conectado` + `[join] ... entrou na sala` de novo a cada poucos
segundos) enquanto a conexão do Patrick ficava estável o tempo todo — ou
seja, não é o servidor caindo por inteiro, é específico da sessão do Boa.

**Descartado:** rede instável tipo wifi/4G — o Boa usa cabo de rede.

**Ainda sem causa confirmada.** Possíveis pistas pra investigar depois:
antivírus/firewall no PC do Boa interferindo na conexão persistente
(WebSocket), configuração de energia/rede adormecendo a interface, ou algum
timeout de inatividade entre o cliente e o Render. Precisa reproduzir de
novo prestando atenção em quanto tempo a conexão dura antes de cair, e se
acontece só parado numa tela específica ou o tempo todo.

---

## [x] 3. Senha de sala não funcionou — campo não foi percebido (CORRIGIDO, não deployado ainda)

**Feito:**
- Modal dedicado de senha (`#room-password-modal`) — aparece em tela cheia,
  impossível de não ver, toda vez que: (a) clica numa sala com cadeado na
  lista, ou (b) a entrada rápida falha por senha errada/faltando.
- Mostra erro inline dentro do próprio modal quando a senha está errada,
  em vez de só devolver pro seletor sem explicação.
- **Segurança reforçada** (server.js): comparação de hash em tempo
  constante (`crypto.timingSafeEqual`, evita timing attack) e limite de
  5 tentativas erradas por IP+sala antes de bloquear por 1 minuto (evita
  força bruta, que antes não tinha nenhuma trava).

Texto antigo mantido abaixo pra referência do que foi investigado:

Confirmado com o Patrick: o problema foi **não ver o campo de senha em
algum lugar** — não foi bypass de segurança nem trava incorreta, foi
questão de visibilidade/UX.

**Suspeita mais forte:** o campo (`#input-room-password`) só existe na tela
"Escolher/Criar Sala" (`#full-room-section`) — quem já tem uma sala salva
cai direto na tela de "Entrada Rápida" (`#quick-join-section`), que **não
mostra campo de senha nenhum** (o valor salvo em localStorage é reenviado
sozinho, sem UI). Se a pessoa foi entrar numa sala com senha vinda da tela
de entrada rápida, nunca viu campo nenhum pra digitar — só ficaria vendo
funcionar/não funcionar sem entender o porquê.

Segunda suspeita, menor: mesmo na tela certa, o campo é um input comum sem
destaque visual (placeholder comprido, mesma aparência de "opcional"), fácil
de passar batido mesmo estando ali.

**Ideias de correção (escolher na hora de implementar):**
- Se a sala escolhida no "Trocar de sala" tiver cadeado, já mostrar um
  popup/campo de senha em destaque (modal dedicado) em vez de só focar um
  input discreto.
- Se o quick-join falhar (senha errada/faltando), a tela já volta pro
  seletor completo com o nome preenchido (isso já existe via `join-error` →
  `returnToLobby`) — mas vale deixar mais claro visualmente que "essa sala
  pede senha, digite abaixo", em vez de só devolver ao seletor sem
  explicação extra.

---

## [ ] 4. Microfone do Patrick parou de funcionar

Reportado, mas a investigação foi interrompida antes de eu conseguir
perguntar os detalhes (ícone aparece mudo? funciona em outros apps? começou
depois de qual ação?). Retomar quando o Patrick puder testar de novo.

---

## [ ] 5. (Feature grande) Sistema de aprovação de novos membros — "Guest" → "Membro"

Ideia trazida pelo Patrick: quem entra numa sala nova cai num cargo
`Guest`/`Pendente`, só enxerga um canal de boas-vindas, fica numa fila até
um admin aprovar ou recusar, e só depois disso ganha acesso de verdade aos
canais — igual o sistema de triagem/verificação do Discord real.

**Isso é uma mudança de arquitetura grande, não um ajuste pontual:** hoje
esse app **não tem banco de dados nenhum** — tudo (salas, canais, mensagens,
quem-tá-em-qual-canal) vive só em `Map`s na memória do `server.js`, e some
se o processo reiniciar. Pra fazer esse sistema de cargos/aprovação direito
(do jeito que o modelo que o Patrick trouxe sugere: tabelas de Usuários,
Servidores, Cargos, Permissões, fila de aprovação persistente) precisaria
de um banco de verdade (Postgres/Mongo) e um sistema de permissões por
cargo — hoje só existe o conceito de "dono da sala" (token secreto), sem
cargos intermediários.

**Não é pra fazer de forma apressada.** Quando for a hora de encarar isso,
vale conversar antes: dá pra fazer uma versão mais simples primeiro (ex: só
uma lista de aprovação em memória, sem banco de dados de verdade) antes de
partir pro modelo completo com bitmask de permissões que o prompt descreve.
