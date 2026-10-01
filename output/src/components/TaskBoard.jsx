import React, { useState, useEffect } from 'react';
import './styles.css';

function TaskBoard() {
  const [tasks, setTasks] = useState([]);
  const [showingCompletedOnly, setShowingCompletedOnly] = useState(false);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    fetch('https://jsonplaceholder.typicode.com/todos?_limit=3')
      .then(response => response.json())
      .then(data => {
        setTasks(
          data.map(item => ({
            id: item.id,
            title: item.title,
            completed: item.completed,
          }))
        );
      })
      .catch(console.error);
  }, []);

  const filteredTasks = showingCompletedOnly
    ? tasks.filter(t => t.completed)
    : tasks;

  const completedCount = filteredTasks.filter(t => t.completed).length;

  const handleAdd = () => {
    const val = inputValue.trim();
    if (val === '') return;
    const newTask = {
      id: 'local-' + Date.now(),
      title: val,
      completed: false,
    };
    setTasks([...tasks, newTask]);
    setInputValue('');
  };

  const handleDelete = id => {
    setTasks(tasks.filter(t => t.id !== id));
  };

  const handleToggle = id => {
    setTasks(
      tasks.map(t =>
        t.id === id ? { ...t, completed: !t.completed } : t
      )
    );
  };

  const handleToggleFilter = () => {
    setShowingCompletedOnly(!showingCompletedOnly);
  };

  const handleClearCompleted = () => {
    setTasks(tasks.filter(t => !t.completed));
  };

  return (
    <div>
      <input
        id="task-input"
        type="text"
        value={inputValue}
        onChange={e => setInputValue(e.target.value)}
        placeholder="Enter a task"
      />
      <button id="add-btn" onClick={handleAdd}>
        Add
      </button>
      <button id="toggle-completed" onClick={handleToggleFilter}>
        {showingCompletedOnly ? 'Show all' : 'Show completed only'}
      </button>
      <button id="clear-completed" onClick={handleClearCompleted}>
        Clear Completed
      </button>
      <div id="stats">
        Total: {filteredTasks.length} | Completed: {completedCount} | Remaining: {
          filteredTasks.length - completedCount
        }
      </div>
      <ul id="task-list">
        {filteredTasks.map(task => (
          <li
            key={task.id}
            data-task-id={task.id}
            className={task.completed ? 'completed' : ''}
          >
            <input
              type="checkbox"
              className="task-checkbox"
              checked={task.completed}
              onChange={() => handleToggle(task.id)}
            />
            <span className="task-text">{task.title}</span>
            <button className="delete-btn" onClick={() => handleDelete(task.id)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default TaskBoard;