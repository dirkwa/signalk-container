const path = require("path");
const { ModuleFederationPlugin } = require("webpack").container;
const packageJson = require("./package.json");

module.exports = {
  entry: "./src/configpanel/index",
  mode: "production",
  output: {
    path: path.resolve(__dirname, "public"),
    clean: false,
  },
  module: {
    rules: [
      {
        test: /\.(jsx?|tsx?)$/,
        loader: "babel-loader",
        exclude: /node_modules/,
        options: {
          presets: [
            "@babel/preset-react",
            // No type-checking — the `tsc` step in `npm run build`
            // catches type errors before webpack runs.  Here we
            // just strip TS syntax to JS.
            "@babel/preset-typescript",
          ],
        },
      },
    ],
  },
  resolve: {
    extensions: [".tsx", ".ts", ".jsx", ".js"],
  },
  plugins: [
    new ModuleFederationPlugin({
      name: packageJson.name.replace(/[-@/]/g, "_"),
      library: {
        type: "var",
        name: packageJson.name.replace(/[-@/]/g, "_"),
      },
      filename: "remoteEntry.js",
      exposes: {
        "./PluginConfigurationPanel":
          "./src/configpanel/PluginConfigurationPanel",
      },
      shared: {
        react: { singleton: true, requiredVersion: "^19" },
        "react-dom": { singleton: true, requiredVersion: "^19" },
      },
    }),
  ],
};
