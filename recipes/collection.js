import { mountRecipeCollection } from "/shared/recipes/recipe-collection.js";

mountRecipeCollection({
  root: "#recipe-collection",
  dataUrl: "/shared/recipes/recipe-data.json"
}).catch(error => {
  console.error("Could not initialize recipe collection:", error);
});
