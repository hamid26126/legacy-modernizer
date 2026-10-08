import React, { useState, useEffect, useRef } from 'react';

function App() {
  const [cities, setCities] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [headerSticky, setHeaderSticky] = useState(false);
  const [heroImgSrc, setHeroImgSrc] = useState('');
  const [dateString, setDateString] = useState('');
  const [weatherData, setWeatherData] = useState(null);
  const [forecastData, setForecastData] = useState([]);
  const [uvColor, setUvColor] = useState('');

  const headerRef = useRef(null);
  const heroImgRef = useRef(null);

  // Load cities from localStorage (keys lastcity0, lastcity1, ...)
  useEffect(() => {
    const list = [];
    const keys = Object.keys(localStorage);
    const cityKeys = keys
      .filter(key => key.startsWith('lastcity'))
      .sort((a, b) => {
        const numA = parseInt(a.replace('lastcity', ''), 10);
        const numB = parseInt(b.replace('lastcity', ''), 10);
        return numA - numB;
      });
    cityKeys.forEach(key => list.push(localStorage.getItem(key)));
    setCities(list);
  }, []);

  // Random hero image on mount
  useEffect(() => {
    const imgArray = ["img/1.png", "img/2.png", "img/3.png", "img/4.png", "img/5.png"];
    const randomImg = imgArray[Math.floor(Math.random() * imgArray.length)];
    setHeroImgSrc(randomImg);
  }, []);

  // Sticky header logic
  useEffect(() => {
    const updateSticky = () => {
      if (headerRef.current) {
        const sticky = headerRef.current.offsetTop;
        if (window.pageYOffset > sticky) {
          setHeaderSticky(true);
        } else {
          setHeaderSticky(false);
        }
      }
    };
    window.addEventListener('scroll', updateSticky);
    updateSticky(); // initial check
    return () => window.removeEventListener('scroll', updateSticky);
  }, []);

  // Clock
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const nmonth = d.getMonth();
      const ndate = d.getDate();
      const nyear = d.getFullYear();
      setDateString(`${nmonth + 1}/${ndate}/${nyear}`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  // Add city to localStorage and state
  const addCity = (city) => {
    let i = 0;
    while (localStorage.getItem(`lastcity${i}`)) i++;
    localStorage.setItem(`lastcity${i}`, city);
    setCities(prev => [...prev, city]);
  };

  // Fetch weather data (current + forecast)
  const fetchWeather = async (city) => {
    const APIKey = "9ba884c10ca90d0ca1f8f0ec657c12b7";
    try {
      // Current weather
      const currentResp = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${APIKey}`
      );
      if (!currentResp.ok) throw new Error('City not found');
      const currentData = await currentResp.json();

      const tempF = (currentData.main.temp - 273.15) * 1.8 + 32;
      const humidity = currentData.main.humidity;
      const windSpeedMs = currentData.wind.speed;
      const windSpeedMPH = (windSpeedMs * 2.236936).toFixed(1);
      const lon = currentData.coord.lon;
      const lat = currentData.coord.lat;

      // UV index
      const uvResp = await fetch(
        `https://api.openweathermap.org/data/2.5/uvi?lat=${lat}&lon=${lon}&appid=${APIKey}`
      );
      const uvData = await uvResp.json();
      const uvIndex = uvData.value;
      let uvBg = '';
      if (uvIndex > 8) uvBg = 'red';
      else if (uvIndex > 6) uvBg = 'orange';
      else if (uvIndex > 3) uvBg = 'yellow';
      else uvBg = 'green';

      const iconUrl = `https://openweathermap.org/img/wn/${currentData.weather[0].icon}.png`;

      setWeatherData({
        cityName: currentData.name,
        tempF,
        humidity,
        windSpeed: parseFloat(windSpeedMPH),
        uvIndex,
        iconUrl
      });
      setUvColor(uvBg);

      // Forecast
      const forecastResp = await fetch(
        `https://api.openweathermap.org/data/2.5/forecast?q=${city}&appid=${APIKey}`
      );
      const forecastData = await forecastResp.json();
      const list = forecastData.list;
      const forecastArr = [];
      for (let i = 0; i < 5; i++) {
        const idx = 5 + 8 * i;
        const item = list[idx];
        const tempF = (item.main.temp - 273.15) * 1.8 + 32;
        const dtTxt = item.dt_txt; // "YYYY-MM-DD HH:MM:SS"
        const mm = dtTxt.substr(5, 2);
        let dd = dtTxt.substr(8, 2);
        if (dd.charAt(0) === '0') dd = dd.substring(1);
        const yyyy = dtTxt.substr(0, 4);
        const date = `${mm}/${dd}/${yyyy}`;
        const icon = `https://openweathermap.org/img/wn/${item.weather[0].icon}.png`;
        forecastArr.push({
          date,
          tempF: parseFloat(tempF.toFixed(2)),
          humidity: item.main.humidity,
          iconUrl: icon
        });
      }
      setForecastData(forecastArr);
    } catch (err) {
      alert('Sorry, try a different spelling or a new city.');
    }
  };

  // Handle search icon click
  const handleSearchClick = async () => {
    const city = inputValue.trim();
    if (!city) return;
    await fetchWeather(city);
    addCity(city);
    setInputValue('');
  };

  // Handle history button click
  const handleHistoryClick = async (city) => {
    setInputValue(city);
    try {
      await fetchWeather(city);
    } finally {
      setInputValue('');
    }
  };

  return (
    <>
      <div className={headerSticky ? 'header sticky' : 'header'} id="myHeader" ref={headerRef}>
        <img src="img/header.png" alt="header txt" />
      </div>

      <div className="container">
        <div className="row">
          <img id="hero" src={heroImgSrc} alt="" ref={heroImgRef} />
          <div id="desktopCityColumn">
            <h2 id="citySearchLabel">city search:</h2>
            <p>no state/country needed.</p>
            <p>try &quot;osaka&quot;, &quot;st. petersburg&quot;, or &quot;wilkes-barre&quot;</p>
            <input
              id="citysearch"
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
            />
            <button
              id="searchicon"
              className="glyphicon glyphicon-search btn btn-light save10"
              onClick={handleSearchClick}
            ></button>
          </div>

          <div id="rightside">
            <div id="mainblock">
              <div className="col">
                <h2>
                  <text id="bigcity">{weatherData?.cityName ?? ''}</text>
                  <text id="clockbox">{dateString}</text>
                  <text id="mainIcon">
                    {weatherData?.iconUrl ? (
                      <img src={weatherData.iconUrl} alt="" />
                    ) : null}
                  </text>
                </h2>
                <p className="tempF">
                  Temperature: {weatherData?.tempF?.toFixed(2) ?? ''} °F
                </p>
                <p className="humidity">
                  Humidity: {weatherData?.humidity ?? ''}%
                </p>
                <p className="wind">
                  Wind Speed: {weatherData?.windSpeed?.toFixed(1) ?? ''} MPH
                </p>
                <br />
                <div id="UVline">
                  <p>
                    UV Index: <text id="UV" style={{ backgroundColor: uvColor }}>
                      {weatherData?.uvIndex ?? ''}
                    </text>
                  </p>
                </div>
              </div>
            </div>
            <div className="col" id="fiveday">
              <h2>5-Day Forecast:</h2>
              <div className="row">
                {forecastData.map((day, idx) => (
                  <div key={idx} className="forecastCard">
                    <h3 id={`fc-dt${idx + 1}`}>{day.date}</h3>
                    <text id={`smallIcon${idx + 1}`}>
                      {day.iconUrl ? (
                        <img src={day.iconUrl} alt="" />
                      ) : null}
                    </text>
                    <p id={`fc-temp${idx + 1}`}>
                      Temp: {day.tempF.toFixed(2)} °F
                    </p>
                    <p id={`fc-humid${idx + 1}`}>
                      Humidity: {day.humidity}%
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="row">
          <div id="mobileHistoryDiv">
            <h3>History:</h3>
            <div id="mobileHistory">
              {cities.map((city, idx) => (
                <button
                  key={idx}
                  className="city"
                  data-name={city}
                  onClick={() => handleHistoryClick(city)}
                >
                  {city}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <footer className="footer">
        <p>
          <a href="https://github.com/coryjquirk/weather-dashboard">Github Repo</a>
          <a href="https://www.github.com/coryjquirk" className="fa fa-github"></a>
          ©2020 <a href="https://coryjquirk.herokuapp.com">Cory Quirk</a>
        </p>
      </footer>
    </>
  );
}

export default App;