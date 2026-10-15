# Como lançar uma atualização

O app "ScreenShare Pro" tem auto-update embutido (`electron-updater`). Uma vez que
um amigo instalou a versão publicada, ele passa a receber as próximas atualizações
sozinho — não precisa mandar o instalador de novo.

Repositório de releases: https://github.com/ptkwan/screenshare-pro

## Toda vez que quiser lançar uma atualização

1. Suba o número da versão em `package.json` (campo `"version"`), seguindo
   [semver](https://semver.org/): `1.0.1` → `1.0.2` (correção pequena),
   `1.1.0` (funcionalidade nova), `2.0.0` (mudança grande).

   > O `electron-updater` só avisa os clientes se a nova versão for **maior**
   > que a que eles têm instalada. Esquecer de subir o número = ninguém recebe
   > a atualização.

2. Commite e envie pra `main`, crie a tag da versão e rode o release:

   ```bash
   git tag v$(node -p "require('./package.json').version") && git push origin main --tags
   export GH_TOKEN=$(gh auth token)
   npm run release
   ```

   > A tag precisa existir ANTES do `npm run release`: o electron-builder 26
   > não cria mais a tag sozinho, e o GitHub recusa a release ("Published
   > releases must have a valid tag") -- ela fica pela metade, sem o `.exe`.

   Isso builda o instalador (`.exe`) e publica a release no GitHub já como
   publicada (`releaseType: release` no `package.json`) -- os amigos passam a
   receber na hora. `dist/` não precisa ser commitado.

3. Se a versão mexe no servidor (`server.js`), publique o servidor no Render
   **antes** do release -- app novo com servidor velho pode não conseguir
   entrar.

4. Pronto. Na próxima vez que cada amigo abrir o app (igual ao Discord):
   - a janelinha de inicialização mostra "Procurando atualizações...",
   - baixa a versão nova com barra de progresso,
   - instala em silêncio (sem assistente do instalador) e reabre já atualizado.

   Se a versão nova sair com o app já aberto, ele percebe na checagem de hora
   em hora e instala em silêncio quando o app for fechado -- nunca derruba
   ninguém no meio de uma chamada.

## Resumo rápido (copiar e colar)

```bash
cd client
# 1. edite "version" em package.json e commite antes de rodar isso
git tag v$(node -p "require('./package.json').version") && git push origin main --tags
export GH_TOKEN=$(gh auth token)
npm run release
```

## Quando é preciso mandar o instalador manualmente de novo

Só na primeira instalação de cada pessoa (ou se alguém desinstalou o app).
O instalador fica em `dist/ScreenShare Pro Setup X.Y.Z.exe` depois do build,
ou disponível diretamente na página de releases:
https://github.com/ptkwan/screenshare-pro/releases/latest

## Windows bloqueando o download/instalação (SmartScreen)

O instalador não é assinado digitalmente (não tem certificado de code
signing), então o SmartScreen do Windows costuma avisar "O Windows
protegeu o seu PC" na primeira instalação de cada pessoa — e isso volta a
acontecer a cada release nova, porque o `.exe` de cada versão tem um hash
diferente (a "reputação" que o SmartScreen guarda não passa de uma versão
pra outra). Não é sinal de que o build saiu errado.

O que fazer:

- **De cara, avise quem for instalar:** na tela do SmartScreen, clicar em
  "Mais informações" → "Executar assim mesmo" libera a instalação. Vale
  colocar esse aviso na descrição de cada release do GitHub.
- **Se quiser reduzir o atrito numa release específica:** dá pra submeter
  o `.exe` pro [Microsoft Defender Security
  Intelligence](https://www.microsoft.com/en-us/wdsi/filesubmission)
  pedindo revisão do arquivo — costuma liberar o hash em 1-2 dias. Precisa
  repetir a cada versão nova (hash muda a cada build).
- **Solução definitiva (paga):** comprar um certificado de code signing
  (~$70-250/ano, ex: SSL.com, Sectigo) e configurar o `electron-builder`
  pra assinar o `.exe` automaticamente no build (`win.certificateFile` /
  `win.certificatePassword` no `package.json`, ou variáveis de ambiente
  equivalentes). Um certificado **EV** (mais caro) libera o SmartScreen
  quase na hora; um certificado comum (OV) ainda constrói reputação com o
  tempo, mas bem mais rápido que sem assinatura nenhuma.
