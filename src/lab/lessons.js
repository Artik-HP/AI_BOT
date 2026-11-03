// A small inspectable curriculum; answers are checked as data, never executed.
function lessons(language, level) {
  if (!["javascript", "python"].includes(language) || !["beginner", "basic"].includes(level)) throw new Error("LAB_TRACK_INPUT");
  const js = language === "javascript";
  const basic = level === "basic";
  const rows = basic ? [
    ["Коллекции", js ? "Массив хранит список: const a = [1, 2]; a.length равно 2." : "Список хранит значения: a = [1, 2]; len(a) равно 2.",
      js ? "Что выведет console.log([3, 5, 7].length)?" : "Что выведет print(len([3, 5, 7]))?", "3", "Посчитай элементы списка."],
    ["Циклы", js ? "Цикл for…of перебирает значения: for (const n of [1, 2]) { /* n */ }." : "Цикл for перебирает значения: for n in [1, 2]: print(n).",
      js ? "let s = 0; for (const n of [2, 4]) s += n; console.log(s); Каков вывод?" : "s = 0\nfor n in [2, 4]:\n    s += n\nprint(s)\nКаков вывод?", "6", "Сложи 2 и 4."],
    ["Функции", js ? "Функция возвращает результат: const add = (a, b) => a + b." : "Функция возвращает результат:\ndef add(a, b):\n    return a + b",
      js ? "const twice = n => n * 2; console.log(twice(5)); Каков вывод?" : "def twice(n):\n    return n * 2\nprint(twice(5))\nКаков вывод?", "10", "Аргумент умножается на два."]
  ] : [
    ["Переменные", js ? "const price = 5; задаёт значение. console.log(price + 1) выводит 6." : "price = 5 задаёт значение. print(price + 1) выводит 6.",
      js ? "const x = 5; console.log(x + 3); Каков вывод?" : "x = 5\nprint(x + 3)\nКаков вывод?", "8", "Подставь x и выполни сложение."],
    ["Условия", js ? "Сравнение 2 > 1 даёт true. if выбирает ветку по условию." : "Сравнение 2 > 1 даёт True. if выбирает ветку по условию.",
      js ? "Что выведет console.log(7 > 4)?" : "Что выведет print(7 > 4)?", js ? "true" : "True", "Семь больше четырёх. Используй запись логического значения языка."],
    ["Выражения", js ? "Скобки задают порядок: (2 + 1) * 2 равно 6." : "Скобки задают порядок: (2 + 1) * 2 равно 6.",
      js ? "Что выведет console.log((1 + 2) * 3)?" : "Что выведет print((1 + 2) * 3)?", "9", "Сначала вычисли сумму в скобках."]
  ];
  return rows.map(([title, explanation, task, answer, hint], index) => ({ id: `${language}-${level}-${index}`,
    title, explanation, task, answer, hint }));
}

module.exports = { lessons };
