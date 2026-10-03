import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';

const API_KEY = "9ba884c10ca90d0ca1f8f0ec657c12b7";
const imgArray = ["img/1.png", "img/2.png", "img/3.png", "img/4.png", "img/5.png"];

function App() {
  const [heroImgSrc, setHeroImgSrc] = useState('');
  const [cityValue, setCityValue] = useState('');
  const [weatherData, setWeatherData] = useState(null);
  const [forecastData, setForecastData] = useState([]);
  const [sticky, setSticky] = useState(false);
  const [stickyOffset, setStickyOffset] = useState(0);
  const headerRef = useRef(null);
  const [clockString, setClockString] = useState('');

  // Sticky header logic
  useLayoutEffect(() => {
    if (headerRef.current) {
      setStickyOffset(headerRef.current.offsetTop);
    }
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      if (window.pageYOffset > stickyOffset) {
        setSticky(true);
      } else {
        setSticky(false);
      }
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [stickyOffset]);

  // Random hero image
  useEffect(() => {
    const randomImg = imgArray[Math.floor(Math.random() * imgArray.length)];
    setHeroImgSrc(randomImg);
  }, []);

  // Clock
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const nmonth = d.getMonth();
      const ndate = d.getDate();
      const nyear = d.getFullYear();
      setClockString(`${nmonth + 1}/${ndate}/${nyear}`);
    };
    tick();
    const intervalId = setInterval(tick, 1000);
    return () => clearInterval(intervalId);
  }, []);

  // Fetch weather data
  const fetchWeather = async (city) => {
    const currentRes = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${API_KEY}`
    );
    if (!currentRes.ok) throw new Error('City not found');
    const currentData = await currentRes.json();

    const { coord: { lat, lon }, name, main: { temp, humidity }, wind: { speed }, weather: [{ icon }] } = currentData;
    const tempF = ((temp - 273.15) * 1.8 + 32).toFixed(2);
    const windMPH = (speed * 2.236936).toFixed(1);

    const uvRes = await fetch(
      `https://api.openweathermap.org/data/2.5/uvi?lat=${lat}&lon=${lon}&appid=${API_KEY}`
    );
    if (!uvRes.ok) throw new Error('UV data failed');
    const uvData = await uvRes.json();
    const uvIndex = uvData.value;
    let uvColor = 'green';
    if (uvIndex > 8) uvColor = 'red';
    else if (uvIndex > 6) uvColor = 'orange';
    else if (uvIndex > 3) uvColor = 'yellow';

    const forecastRes = await fetch(
      `https://api.openweathermap.org/data/2.5/forecast?q=${city}&appid=${API_KEY}`
    );
    if (!forecastRes.ok) throw new Error('Forecast failed');
    const forecastData = await forecastRes.json();
    const forecastList = forecastData.list;

    const forecast = [];
    for (let i = 0; i < 5; i++) {
      const idx = 5 + 8 * i;
      const item = forecastList[idx];
      const dt = new Date(item.dt_txt);
      const month = dt.getMonth() + 1;
      const day = dt.getDate();
      const year = dt.getFullYear();
      const formattedDate = `${month}/${day}/${year}`;
      const tempFItem = ((item.main.temp - 273.15) * 1.8 + 32).toFixed(2);
      const humidityItem = item.main.humidity;
      const iconItem = item.weather[0].icon;
      forecast.push({
        date: formattedDate,
        tempF: tempFItem,
        humidity: humidityItem,
        icon: iconItem,
      });
    }

    return {
      name,
      tempF,
      humidity,
      windMPH,
      uvIndex,
      uvColor,
      icon,
      forecast,
    };
  };

  const handleSearch = async () => {
    const city = cityValue.trim();
    if (!city) return;
    try {
      const result = await fetchWeather(city);
      setWeatherData(result);
      setForecastData(result.forecast);
      // store in localStorage
      const index = localStorage.length;
      localStorage.setItem(`lastcity${index}`, city);
      setCityValue('');
    } catch (err) {
      alert('Sorry, try a different spelling or a new city.');
    }
  };

  // Render history buttons from localStorage
  const renderHistoryButtons = () => {
    const buttons = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = Object.keys(localStorage)[i];
      if (key.startsWith('lastcity')) {
        const city = localStorage.getItem(key);
        if (city) {
          buttons.push(
            <button
              key={key}
              className="city"
              data-name={city}
              onClick={() => {
                setCityValue(city);
                handleSearch();
              }}
            >
              {city}
            </button>
          );
        }
      }
    }
    return buttons;
  };

  return (
    <>
      <div className={`header ${sticky ? 'sticky' : ''}`} id="myHeader" ref={headerRef}>
        <img src="img/header.png" alt="header txt" />
      </div>
      <div className="container">
        <div className="row">
          <img id="hero" src={heroImgSrc} alt="" />
          <div id="desktopCityColumn">
            <h2 id="citySearchLabel">city search:</h2>
            <p>no state/country needed.</p>
            <p>try &quot;osaka&quot;, &quot;st. petersburg&quot;, or &quot;wilkes-barre&quot;</p>
            <input
              id="citysearch"
              type="text"
              value={cityValue}
              onChange={(e) => setCityValue(e.target.value)}
            />
            <button
              id="searchicon"
              className="glyphicon glyphicon-search btn btn-light save10"
              onClick={handleSearch}
            >
              Search
            </button>
          </div>
          <div id="rightside">
            <div id="mainblock">
              <div className="col">
                <h2>
                  <text id="bigcity">{weatherData?.name ?? ''}</text>
                  <text id="clockbox">{clockString}</text>
                  <text id="mainIcon">
                    {weatherData?.icon ? (
                      <img src={`https://openweathermap.org/img/wn/${weatherData.icon}.png`} alt="" />
                    ) : null}
                  </text>
                </h2>
                <p className="tempF">
                  Temperature: {weatherData?.tempF ?? ''} °F
                </p>
                <p className="humidity">
                  Humidity: {weatherData?.humidity ?? ''}%
                </p>
                <p className="wind">
                  Wind Speed: {weatherData?.windMPH ?? ''} MPH
                </p>
                <br />
                <div id="UVline">
                  <p>
                    UV Index: <text id="UV" style={{ backgroundColor: weatherData?.uvColor }}>
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
                      <img src={`https://openweathermap.org/img/wn/${day.icon}.png`} alt="" />
                    </text>
                    <p id={`fc-temp${idx + 1}`}>Temp: {day.tempF} °F</p>
                    <p id={`fc-humid${idx + 1}`}>Humidity: {day.humidity}%</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="row">
          <div id="mobileHistoryDiv">
            <h3>History:</h3>
            <div id="mobileHistory">{renderHistoryButtons()}</div>
          </div>
        </div>
      </div>
      <div className="footer">
        <p>
          <a href="https://github.com/coryjquirk/weather-dashboard">Github Repo</a>
          <a href="https://www.github.com/coryjquirk" className="fa fa-github"></a>
          ©2020 <a href="https://coryjquirk.herokuapp.com">Cory Quirk</a>
        </p>
      </div>
    </>
  );
}

export default App;