# Light

## Публикация на GitHub Pages

Проект настроен на автодеплой через GitHub Actions.

1. Убедитесь, что основной бранч называется `main`.
2. В репозитории откройте `Settings -> Pages`.
3. В `Source` выберите `GitHub Actions`.
4. Запушьте изменения в `main`.
5. Дождитесь выполнения workflow `Deploy to GitHub Pages`.

Сайт будет доступен по адресу:

`https://<your-username>.github.io/<repo-name>/`

## Локальная разработка

```bash
npm install
npm run dev
```

## Сборка

```bash
npm run build
```
