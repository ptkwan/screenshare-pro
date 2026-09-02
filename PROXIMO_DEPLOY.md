# Próximo Deploy — Backlog

Lista de coisas pra investigar/corrigir e subir tudo junto na próxima leva
(em vez de um build+release pra cada item). Vamos anotando aqui conforme
aparece, e só faz o ciclo de build/release quando decidirmos "bora subir".

Status: `[ ]` pendente · `[~]` investigando · `[x]` corrigido (mas ainda não deployado)

---

## [~] 12. Persistência de verdade com Upstash Redis (código pronto, falta a conta)

Pedido do Patrick depois do item 11: já que as salas "ficam de pé", que
sobrevivam também a um restart do servidor de verdade (não só enquanto o
processo ficar de pé). Ele escolheu Upstash Redis (mais parecido com o
que já existe hoje -- o código já usa Maps/Sets na memória, então a
migração é praticamente 1-pra-1).

**Feito**: `server.js` agora tem uma camada de persistência opcional --
com `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` configurados
(variáveis de ambiente no Render, nunca no código), cada sala é salva
como um snapshot (canais, mensagens, senha, ícone, token de dono, nomes
aprovados) e recuperada automaticamente quando o servidor sobe de novo.
Sem essas variáveis, o app funciona exatamente como antes (só memória) --
zero risco pra quem ainda não configurou nada.

**Bloqueado no Patrick**: preciso que ele crie a conta grátis no
upstash.com, crie um banco Redis, e me passe `UPSTASH_REDIS_REST_URL` e
`UPSTASH_REDIS_REST_TOKEN` (da aba "REST API" do banco). Depois disso
preciso configurar essas duas variáveis no painel do Render também.

**Testado**: rodei a suíte de regressão completa com as variáveis
ausentes (o caminho que já está em produção agora) -- tudo funciona igual
a antes, sem nenhum erro. **Não testado ainda**: o vai-e-volta de verdade
com o Redis (só dá pra testar depois de ter as credenciais).

---

## [x] 11. Salas persistentes, painel de participantes removido, mic no card, ruído de teclado (CORRIGIDO, não deployado ainda)

Lote de pedidos do Patrick:

- **Toques de voz mais altos + tocam pra mim também**: volume do "blip"
  subiu (0.16 → 0.38 do volume geral), e agora toca também quando EU
  mesmo entro/saio de um canal de voz (antes só tocava pra quem já
  estava lá vendo outra pessoa entrar/sair).

- **Salas "ficam de pé pra sempre"**: o servidor não apaga mais canais,
  mensagens, senha, ícone e token de dono quando a sala fica vazia — só
  isso não sobrevive a um **restart do processo do servidor** (sem banco
  de dados, é tudo em memória; o ícone que sumiu era provavelmente por
  isso). Corrigido junto: quem tentava entrar numa sala persistente
  *vazia* ficava preso pra sempre na fila de aprovação (ninguém pra
  aprovar) — agora entra direto, e quem já tava esperando quando a sala
  esvaziou entra automaticamente.

- **Ruído de teclado no microfone**: adicionadas as constraints extras do
  Chromium (`googTypingNoiseDetection` e afins) no `getUserMedia`, que
  miram exatamente esse tipo de ruído. Não é o mesmo nível do Krisp/
  RNNoise (isso continua no item 7, não é trivial), mas é uma melhora real
  e imediata sem precisar de nenhuma lib nova.

- **Botão de mic no seu próprio card da sidebar**: clicar no ícone de
  microfone ao lado do seu nome (embaixo, na barra de canais) muta/ativa
  direto, igual o Discord — antes só dava pra mutar pelo botão do rodapé.

- **Painel de participantes (direita) removido**: era repetitivo com a
  lista de quem já aparece dentro de cada canal de voz na sidebar
  esquerda. O botão de renomear o próprio nome, que só existia ali, foi
  pro card da sidebar junto com o mic. Kick/volume por pessoa continuam
  disponíveis pelo clique direito nas linhas da sidebar (já existia,
  independente do painel removido).
  **Trade-off avisado**: quem está na sala só no chat de texto (sem
  entrar em nenhum canal de voz) não aparece em lugar nenhum da interface
  agora — antes aparecia nesse painel.

- **"AO VIVO" na sidebar em vez de só no topo do painel de voz**: quem
  está compartilhando tela agora mostra um selo AO VIVO/ASSISTINDO direto
  na lista de membros do canal de voz na sidebar esquerda, e é por ali que
  dá pra entrar na stream da pessoa (clicando no selo ou na linha).

**Testado** com dois clientes: renomear pelo card, mutar pelo card, sala
continuando na lista depois de esvaziar, segunda pessoa entrando direto
numa sala vazia sem aprovação, selo AO VIVO aparecendo e funcionando na
sidebar, e os toques de entrada/saída (inclusive pra mim mesmo). Suite de
regressão completa rodada de novo, sem erros de console.

---

## [x] 10. Toques de entrar/sair da chamada de voz (CORRIGIDO, não deployado ainda)

Pedido do Patrick: som quando alguém entra e outro quando sai da chamada,
tipo Discord.

Gerado na hora via Web Audio (osciladores simples, um "blip" subindo pra
entrada e um descendo pra saída) — sem depender de nenhum arquivo de áudio
externo. Toca só localmente (ligado direto em `ctx.destination`, nunca no
grafo de envio do WebRTC), então ninguém mais ouve. Respeita o mudo geral
(`btn-volume`) e o volume configurado.

Detecta quem entrou/saiu comparando a lista de membros do MEU canal de voz
a cada atualização do servidor (não precisou de nenhum evento novo). Não
toca som pros membros que já estavam lá quando eu entrei, nem quando eu
mesmo troco de canal.

**Testado** com dois clientes: som de entrada dispara exatamente 1 vez
quando o segundo entra na mesma sala de voz, som de saída dispara quando
ele sai, e trocar de canal sozinho não dispara nenhum som falso.

---

## [x] 9. Trocar de servidor tipo Discord + ícones de sala (CORRIGIDO, não deployado ainda)

Pedido do Patrick com prints comparando com o Discord. Três coisas juntas:

- **Barra de servidores conhecidos** (nova coluna estreita à esquerda,
  antes da lista de canais): mostra ícones das salas que você já entrou
  (lembradas localmente, até 8), com a atual destacada (barrinha branca,
  igual Discord). Clicar troca de sala sem fechar o app -- sai da atual e
  entra na escolhida. Botão "+" no fim da barra abre o seletor de salas
  pra entrar em outra ou criar uma nova, mesmo já estando conectado.
- **Ícone de sala**: o dono pode trocar (botão novo do lado de
  renomear/sair), aparece na barra de servidores e na lista de salas
  ativas. Sem ícone, mostra a inicial do nome (mesmo padrão do avatar).
- **Tela inicial sempre mostra a lista de salas** em vez de pular direto
  pra última sala usada -- pedido explícito do Patrick, pra sempre dar
  pra escolher outro servidor. A "entrada rápida" antiga foi removida (a
  barra de servidores resolve esse caso de uso melhor).
- Sala com senha continua pedindo a senha normalmente nesse fluxo todo
  (reaproveita o modal que já existia).

**Importante, avisado ao Patrick:** isso é troca rápida (sai de uma,
entra na outra), não ficar conectado em várias ao mesmo tempo como o
Discord de verdade faz -- isso exigiria manter várias conexões de
voz/WebRTC em paralelo, mudança bem maior que não foi pedida.

**Não implementado (avaliado e descartado por impossibilidade técnica):**
compartilhar uma aba específica do navegador (tipo o seletor do Google
Meet). Isso só funciona quando o app QUE PEDE a captura é o próprio
navegador -- um app externo como o Roshan não tem acesso às abas de
dentro do Chrome/Edge, só a janelas inteiras (isso o navegador já expõe
via `desktopCapturer`). Compartilhar a janela do navegador (em vez de
"Tela Cheia") já usa a captura nativa por processo, sem eco -- resolve a
maior parte do caso de uso na prática.

**Testado** com dois clientes reais: criar sala, trocar ícone, criar
segunda sala com senha pelo botão "+", voltar pra primeira clicando no
ícone dela na barra, confirmar que o ícone customizado aparece
corretamente, confirmar que a tela inicial sempre mostra a lista (sem
pular direto pra sala salva), e que sala com senha ainda pede senha
corretamente nesse fluxo. No caminho, achado e corrigido um bug real que
travava o pedido da lista de salas -- ver `BUGS.md`.

---

## [x] 8. Redesign de UX/UI (CORRIGIDO, não deployado ainda)

Redesign completo da interface, feito em 3 fases com aprovação do Patrick em
cada uma (diagnóstico → prévia visual → implementação). Sem mudar nenhuma
lógica de WebSocket/WebRTC/áudio/screen share — só estrutura, hierarquia e
estilo.

**O que mudou:**
- Header único: nome do app + contexto do canal atual juntos numa barra só
  (antes eram duas barras separadas). Relógio removido.
- Canal de voz conectado fica visualmente óbvio: verde + selo "AO VIVO" no
  header, diferente do canal de texto (neutro, ícone de #).
- Bloco fixo de usuário (nome + avatar + estado do mic) sempre visível no
  rodapé da sidebar esquerda, não só durante uma call.
- Rodapé com prioridade visual clara: mic/compartilhar tela/sair maiores e
  em destaque; qualidade/tela cheia/toggles/saída de áudio menores e
  discretos; slider de volume mais compacto.
- Entrar num canal de voz agora dá feedback imediato — troca a tela na hora
  e mostra "Conectando microfone..." enquanto isso, em vez de ficar ~1s+
  parado sem nenhuma indicação (correção da causa raiz identificada no
  diagnóstico: a troca de view esperava `ensureMicStream()` terminar antes
  de renderizar).
- Vídeo/tela compartilhada ocupa o espaço todo quando só tem 1 transmissão
  (antes sobrava espaço morto do lado).
- Empty state no chat de texto vazio ("Bem-vindo a #canal").
- Toast reposicionado pra nunca cobrir o header, o botão de Aprovações ou o
  título do painel de participantes.
- Sidebar de canais ganhou um toggle que funciona em qualquer largura de
  janela (antes sumia abaixo de 768px sem nenhum jeito de reabrir). O
  toggle de participantes, que tinha o mesmo problema (pré-existente, não
  introduzido agora), foi corrigido junto — ver `BUGS.md`.

**Testado** de ponta a ponta com Playwright pilotando o Electron de verdade
contra um servidor local: conectar, trocar de canal, enviar/receber
mensagem, aprovação de entrada, entrar/sair de voz (com medição do tempo de
feedback), mutar mic, compartilhar/parar de compartilhar tela, abrir modal
de qualidade, redimensionar (1366×768, 1920×1080, 700px), toggles de
sidebar nas duas larguras, sair da sala. Nenhum erro de console em nenhum
passo.

**Build empacotado testado também** (`electron-builder --dir` → `Roshan.exe` de
verdade, não `electron .`): entrar na sala, voz, e especialmente a captura
nativa de áudio de tela cheia (o tipo de coisa que historicamente só
quebrava no empacotado, ver `BUGS.md` 2026-09-01) — tudo funcionou igual ao
modo dev. Único achado: um warning de console cosmético e inofensivo
("Failed to load resource" pra uma URL bugada tipo `${s.thumbnail}`) —
causado pelo scanner de pré-carregamento do Chromium lendo bytes crus de
dentro de um template literal JS como se fosse HTML; nunca chega a afetar
nada funcional (a imagem real da miniatura carrega normal depois). Não vale
a pena mexer no código só por causa disso.

---

## [x] 6. Sair da sala / trocar de servidor sem fechar o app (CORRIGIDO, não deployado ainda)

Reportado pelo Patrick com print: depois de entrar numa sala, não tinha
como voltar pro seletor e entrar em outra sem fechar o app inteiro. No
caminho, achamos a causa de um bug relacionado: nome de sala virava
"[object Object]" e ficava permanente por falta de validação no servidor.
Os dois foram corrigidos juntos — detalhe técnico e validação automatizada
em `BUGS.md` (2026-09-02).

---

## [ ] 7. Supressão de ruído tipo Krisp (RNNoise)

Pedido do Patrick: o Discord tem o Krisp pra cortar ruído de fundo, dá pra
ter algo parecido?

Krisp em si é uma SDK paga/proprietária — não dá só "instalar". O
microfone já usa a supressão de ruído nativa do Chromium
(`noiseSuppression: true` em `ensureMicStream()`), mas é mais fraca que o
Krisp.

**Alternativa gratuita de qualidade parecida**: RNNoise (open-source, roda
via WASM). Daria pra integrar no mesmo pipeline de AudioWorklet que já
existe pra áudio nativo (`setupNativeAudioPlumbing`), processando o áudio
do microfone antes de mandar pro chat de voz. Não é trivial (precisa achar/
empacotar o build WASM do RNNoise e encaixar no worklet), então vale
avaliar o esforço antes de entrar na fila.

---

## [x] 1. Compartilhar "Tela Cheia" com áudio do sistema não funciona (CORRIGIDO, não deployado ainda)

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

**Feito:** a lib `loopback-capture` já tem um modo pronto pra isso
(`startSystemAudio`, sem PID — pega o que o dispositivo de saída padrão
está tocando). Adicionado `start-system-audio-capture` no `main.js`/
`preload.js`, e `index.html` agora usa esse caminho nativo quando a fonte
escolhida é "Tela Cheia" (`sourceId` começando com `screen:`), caindo pro
jeito antigo só se a captura nativa falhar. O mute-lock automático (evitar
eco) continua valendo igual antes, porque captura de sistema inteiro ainda
pega o que sai do chat de voz — só o "por app" (janela específica) escapa
dessa trava.

**Testado** com Playwright pilotando o app Electron de verdade (não só em
dev, contra `node server.js` local): compartilhar "Tela Cheia" com "Áudio
do Sistema" funciona sem erro. No caminho, achamos e corrigimos um bug real
de CSP que provavelmente já quebrava a captura por app desde a v1.8.0 —
ver `BUGS.md` (2026-09-02). **Falta testar** o build empacotado
(`electron-builder --dir`) — o teste até aqui rodou via `electron .`
direto, não pelo instalador.

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

**Bloqueado no Patrick:** preciso que você escolha o provedor e crie a
conta — não dá pra eu gerar credenciais de um serviço de terceiro por
você. Depois de ter usuário/senha (ou API key), me manda que eu coloco no
`iceServers`.

---

## [x] 2c. Faltava log de ICE pro chat de voz (CORRIGIDO, não deployado ainda)

Relato do Patrick: um amigo compartilhando tela — dá pra ver a tela e ouvir
o áudio do jogo dele, mas a voz do microfone dele não chega. Sintoma
compatível com o mesmo problema do item 2 (sem TURN, a conexão falha
especificamente quando essa pessoa é quem transmite) — só que dessa vez na
conexão de VOZ, não na de tela.

**Problema**: não dava pra confirmar, porque o log de estado ICE (o mesmo
que foi usado pra diagnosticar o binonha) só existia pro compartilhamento
de tela -- o chat de voz nunca teve esse log.

**Corrigido**: `createVoicePeer()` agora loga o estado ICE
(`ICE (voz com X): connected/checking/failed/...`) igual já acontecia pro
compartilhamento de tela. Testado com dois clientes -- aparece certinho no
log do servidor.

Com isso, da próxima vez que alguém reportar "não consigo ouvir a voz de
fulano", dá pra abrir o painel do Render e confirmar se é ICE falhando
(aponta pra falta de TURN, item 2) ou outra coisa.

---

## [~] 2b. Conexão do Boa cai e reconecta em loop (`transport error`/`transport close`)

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

**Mitigação aplicada (não é a correção definitiva, porque a causa raiz
ainda não tá confirmada):** `pingTimeout` do socket.io no `server.js` subiu
de 20s (padrão) pra 60s. Isso dá mais tolerância pra hiccups breves de rede
não derrubarem a conexão à toa — se a causa for algo tipo "a interface do
Boa dorme por 1-2s e perde um ping", isso deve sumir. Se o loop continuar
mesmo assim, aponta mais forte pra antivírus/firewall matando a conexão
ativamente (não timeout), ou o próprio Render.

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

## [x] 4. Microfone do Patrick parou de funcionar (CANCELADO — voltou a funcionar sozinho)

Reportado, mas a investigação foi interrompida antes de conseguir
perguntar os detalhes. Confirmado com o Patrick em 2026-09-02 que o
microfone voltou a funcionar sem nenhuma mudança de código — provavelmente
foi algo pontual do Windows/driver, não do app. Sem ação necessária; reabrir
se acontecer de novo.

---

## [x] 5. Sistema de aprovação de novos membros (CORRIGIDO, não deployado ainda)

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

**Implementado (versão simples, escolhida com o Patrick):** sem banco de
dados, sem cargos — o **dono da sala já existente é o decisor**. Toda vez
que alguém tenta entrar numa sala já criada e não é o dono, fica numa tela
de "Aguardando aprovação" até o dono aceitar ou recusar. O dono vê um botão
"Aprovações" no cabeçalho (com contador) sempre que tiver alguém esperando,
com nome/foto de cada um e botões de aprovar/recusar. Uma vez aprovado, a
pessoa (pelo nome) não precisa pedir de novo enquanto o servidor não
reiniciar — sem banco, isso não persiste além disso.

- `server.js`: `roomPendingJoins` (fila por sala) + `roomApprovedNames`
  (quem já foi aprovado nessa sessão do servidor), eventos `join-pending`,
  `approve-join`, `reject-join`, `cancel-join-request`,
  `pending-joins-update`.
- `index.html`: modal "Aguardando aprovação" (quem tá entrando) e modal da
  fila de aprovação (dono), botão no cabeçalho com badge de contagem.
- **Testado** duas vezes: primeiro um script simulando dono + 3 convidados
  direto no `server.js` (fica pendente, dono vê a fila, aprova, reconexão
  do mesmo nome não pede de novo, recusa funciona), depois com Playwright
  pilotando duas instâncias reais do Electron lado a lado (dono cria a
  sala, convidado tenta entrar, vê o modal de espera, dono vê o badge +
  fila com o nome certo, aprova, convidado entra, contagem de participantes
  bate nos dois lados) — todos os cenários passaram na UI de verdade.
  **Não testado ainda** no build empacotado.
- **Como usar:** não precisa "cadastrar" ninguém com antecedência — o amigo
  só entra na sala normalmente (nome + senha se tiver) e o pedido aparece
  sozinho pro dono aprovar.

**Não é o modelo completo** que o Patrick trouxe (cargos Guest/Membro,
permissões, canal de boas-vindas) — é a versão mínima que resolve "eu
decido quem entra". Se quiser evoluir pra esse modelo completo depois, vale
conversar antes: aí sim precisa de banco de dados de verdade.
