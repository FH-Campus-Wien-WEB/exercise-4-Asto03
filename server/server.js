const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const config = require("./config.js");
const movieModel = require("./movie-model.js");
const userModel = require("./user-model.js");
const FileStore = require('session-file-store')(session);
const app = express();

// Parse urlencoded bodies
app.use(bodyParser.json());

// Session middleware
// instead of nodemon, use node server/server.js
app.use(session({
  //needs to store the sessio somewhere
  store: new FileStore({ path: './sessions' }),
  secret: config.sessionSecret,
  resave: false,
  //tells the server that the session is stored
  saveUninitialized: false,
  cookie: { secure: false } // Set to true if using HTTPS
}));

// Serve static content in directory 'files'
app.use(express.static(path.join(__dirname, "files")));

app.post("/login", function (req, res) {
  const { username, password } = req.body;
  //searches for user entry
  const user = userModel[username];
  //if the user was found and the entered password is correct create session for user
  if (user && bcrypt.compareSync(password, user.password)) {
    req.session.user = {
      username,
      firstName: user.firstName,
      lastName: user.lastName,
      loginTime: new Date().toISOString(),
    };
    res.send(req.session.user);
  } else {
    res.sendStatus(401);
  }
});

// Task 1.3: Implement the GET `/logout` endpoint and requireLogin
// protection. Implement logout by destroying the session 
// with error handling. Protect all endpoints that need 
// authentication with `requireLogin`.

app.get("/logout", function (req, res) {
  req.session.destroy();
  res.sendStatus(200);
});

function requiredLogin(req, res, next) {
  if(!req.session || !req.session.user) {
    res.sendStatus(401);
  } else {
    next()
  }
};

app.get("/session", function (req, res) {
  if (req.session.user) {
    res.send(req.session.user);
  } else {
    res.status(401).json(null);
  }
});

app.get("/movies", requiredLogin, function (req, res) {
  const username = req.session.user.username;
  let movies = Object.values(movieModel.getUserMovies(username));
  const queriedGenre = req.query.genre;
  if (queriedGenre) {
    movies = movies.filter((movie) => movie.Genres.indexOf(queriedGenre) >= 0);
  }
  res.send(movies);
});

// Configure a 'get' endpoint for a specific movie
app.get("/movies/:imdbID", function (req, res) {
  const username = req.session.user.username;
  const id = req.params.imdbID;
  const movie = movieModel.getUserMovie(username, id);

  if (movie) {
    res.send(movie);
  } else {
    res.sendStatus(404);
  }
});

// Configure a 'put' endpoint for a specific movie to update or insert a movie
app.put("/movies/:imdbID", requiredLogin, function (req, res) {
  const username = req.session.user.username;
  const imdbID = req.params.imdbID;
  const exists = movieModel.getUserMovie(username, imdbID) !== undefined;

  if (!exists) {
    // Task 2.3: Fetch the movie data from OmdbAPI, follow the pattern used further down 
    // in the GET /search endpoint. Implement conversion of the OmdbAPI response to the 
    // movie format used in the frontend. Make sure to handle errors and timeouts properly.
    if (!imdbID) {
      return res.sendStatus(400);
    }
    const url = `http://www.omdbapi.com/?i=${encodeURIComponent(imdbID)}&apikey=${config.omdbApiKey}`;
    console.log(url);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.omdbTimeoutMs);
    fetch(url, { signal: controller.signal })
        .then(apiRes => {
          clearTimeout(timeoutId);
          if (!apiRes.ok) {
            return res.sendStatus(apiRes.status);
          }
          return apiRes.json();
        })
        .then(response => {
          const movie = {
            imdbID: response.imdbID,
            Title: response.Title,
            Released: response.Released,
            Runtime: response.Runtime,
            Genres: response.Genre ? response.Genre.split(', ') : [],
            Directors: response.Director ? response.Director.split(', ') : [],
            Writers: response.Writer ? response.Writer.split(', ') : [],
            Actors: response.Actors ? response.Actors.split(', ') : [],
            Plot: response.Plot,
            Poster: response.Poster,
            Metascore: response.Metascore,
            imdbRating: response.imdbRating
          }
          movieModel.setUserMovie(username, imdbID, movie);
          res.send(201);
        })
        .catch((err) => {
          clearTimeout(timeoutId);
          if (err.name === 'AbortError') {
            console.error('OMDb API request timeout');
            return res.sendStatus(504);
          }
          console.error('OMDb API error:', err);
          res.sendStatus(500);
        });
  } else {
    movieModel.setUserMovie(username, imdbID, req.body);
    res.sendStatus(200);
  }
});

app.delete("/movies/:imdbID", requiredLogin, function (req, res) {
  const username = req.session.user.username;
  const id = req.params.imdbID;
  if (movieModel.deleteUserMovie(username, id)) {
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Configure a 'get' endpoint for genres of all movies of the current user
app.get("/genres", requiredLogin, function (req, res) {
  const username = req.session.user.username;
  const genres = movieModel.getGenres(username);
  genres.sort();
  res.send(genres);
});

/* Task 2.1. Add the GET /search endpoint: Query omdbapi.com and return
   a list of the results you obtain. Only include the properties 
   mentioned in the README when sending back the results to the client. */
app.get("/search", requiredLogin, function (req, res) {
  const username = req.session.user.username;
  const query = req.query.query;
  if (!query) {
    return res.sendStatus(400);
  }

  const url = `http://www.omdbapi.com/?s=${encodeURIComponent(query)}&apikey=${config.omdbApiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.omdbTimeoutMs);

  fetch(url, { signal: controller.signal })
    .then(apiRes => {
      clearTimeout(timeoutId);
      if (!apiRes.ok) {
        return res.sendStatus(apiRes.status);
      }
      return apiRes.text().then(data => {
        let response;
        try {
          response = JSON.parse(data);
        } catch (parseError) {
          console.error('Failed to parse OMDb response:', parseError);
          return res.sendStatus(500);
        }

        if (response.Response === 'True') {
          const results = response.Search
            .filter(movie => !movieModel.hasUserMovie(username, movie.imdbID))
            .map(movie => ({
              Title: movie.Title,
              imdbID: movie.imdbID,
              Year: isNaN(movie.Year) ? null : parseInt(movie.Year)
            }));
          res.send(results);
        } else {
          res.send([]);
        }
      });
    })
    .catch((err) => {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        console.error('OMDb API request timeout');
        return res.sendStatus(504);
      }
      console.error('OMDb API error:', err);
      res.sendStatus(500);
    });
});

app.listen(config.port);

console.log(`Server now listening on http://localhost:${config.port}/`);
