import React, { useState, useEffect } from 'react';

function TaskItem({ task, onToggle, onDelete }) {
  return (
    <li
      className={task.completed ? 'completed' : ''}
      data-task-id={task.id}
    >
      <input
        type="checkbox"
        className="task-checkbox"
        checked={task.completed}
        onChange={() => onToggle(task.id)}
      />
      <span className="task-text">{task.title}</span>
      <button className="delete-btn" onClick={() => onDelete(task.id)}>
        Delete
      </button>
    </li>
  );
}

function App() {
  const [tasks, setTasks] = useState([]);
  const [showCompletedOnly, setShowCompletedOnly] = useState(false);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    fetch('https://jsonplaceholder.typicode.com/todos?_limit=3')
      .then(response => response.json())
      .then(data => {
        const mapped = data.map(item => ({
          id: item.id.toString(),
          title: item.title,
          completed: item.completed
        }));
        setTasks(mapped);
      });
  }, []);

  const handleAdd = () => {
    const trimmed = inputValue.trim();
    if (trimmed === '') return;
    const newTask = {
      id: `local-${Date.now()}`,
      title: trimmed,
      completed: false
    };
    setTasks(prev => [...prev, newTask]);
    setInputValue('');
  };

  const handleToggle = id => {
    setTasks(prev =>
      prev.map(t =>
        t.id === id ? { ...t, completed: !t.completed } : t
      )
    );
  };

  const handleDelete = id => {
    setTasks(prev => prev.filter(t => t.id !== id));
  };

  const handleToggleCompleted = () => {
    setShowCompletedOnly(!showCompletedOnly);
  };

  const handleClearCompleted = () => {
    setTasks(prev => prev.filter(t => !t.completed));
  };

  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const remaining = total - completed;

  const visibleTasks = showCompletedOnly
    ? tasks.filter(t => t.completed)
    : tasks;

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
      <button id="toggle-completed" onClick={handleToggleCompleted}>
        {showCompletedOnly ? 'Show all' : 'Show completed only'}
      </button>
      <button id="clear-completed" onClick={handleClearCompleted}>
        Clear Completed
      </button>
      <div id="stats">
        Total: {total} | Completed: {completed} | Remaining: {remaining}
      </div>
      <ul id="task-list">
        {visibleTasks.map(task => (
          <TaskItem
            key={task.id}
            task={task}
            onToggle={handleToggle}
            onDelete={handleDelete}
          />
        ))}
      </ul>
    </div>
  );
}

export default App;