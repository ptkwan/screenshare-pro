module.exports = {
  content: ['./index.html'],
  theme: {
    extend: {
      colors: {
        // "zinc" reescrito com um sub-tom quente (a mesma ideia da escala
        // "stone" do Tailwind, com um pouco menos de saturação pra não virar
        // "bege/poeira") em vez do zinc padrão, que puxa pro azul-acinzentado
        // e lê como frio/duro. Os mesmos passos de luminosidade do zinc
        // original foram mantidos -- só o tom muda -- então contraste e
        // hierarquia visual continuam idênticos, só ficam mais "aveludados".
        // Reaproveita as classes zinc-* que já existem no app inteiro, então
        // não precisa trocar nenhuma classe no HTML.
        zinc: {
          50: '#faf9f7',
          100: '#f3f1ee',
          200: '#e6e2dc',
          300: '#d3cdc4',
          400: '#a89e93',
          500: '#7d7468',
          600: '#5a5249',
          700: '#453f38',
          800: '#2b2724',
          900: '#1c1917',
          950: '#0f0d0b',
        },
      },
    },
  },
  plugins: []
};
