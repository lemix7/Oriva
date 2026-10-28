import app from "./app.ts";

const port = process.env.PORT || 4000;

app.listen(port, () => {
  console.log(`The app is running on port ${port}`);
});
