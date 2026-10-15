module.exports = {
  content: ['./index.html'],
  theme: {
    extend: {
      colors: {
        // Paleta escura no estilo Discord. Reaproveita as classes zinc-*,
        // blue-* e emerald-* que já existem no app inteiro, então não precisa
        // trocar nenhuma classe no HTML -- só o tom muda.
        //   950 = barra de servidores · 900 = sidebar/painéis · 800 = hover
        //   700 = item selecionado · 400/500 = texto apagado · 200 = texto normal
        zinc: {
          50: '#f2f3f5',
          100: '#f2f3f5',
          200: '#dbdee1',
          300: '#b5bac1',
          400: '#949ba4',
          500: '#80848e',
          600: '#4e5058',
          700: '#404249',
          800: '#35373c',
          900: '#2b2d31',
          950: '#1e1f22',
        },
        // "blurple" (cor de destaque) no lugar do azul padrão
        blue: {
          300: '#c9cdfb',
          400: '#949cf7',
          500: '#4752c4',
          600: '#5865f2',
        },
        emerald: {
          400: '#2dc770',
          500: '#23a55a',
          600: '#248046',
        },
      },
      fontFamily: {
        sans: ['"gg sans"', '"Noto Sans"', '"Segoe UI"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: []
};
