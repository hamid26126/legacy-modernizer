import React, { useState, useEffect } from 'react';

const TaskInput = ({ onAdd }) => {
  const [value, setValue] = useState('');

  const handleSubmit = e => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) {
      onAdd(trimmed);
      setValue('');
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange{e => setValue(e.target.value)}
        placeholder="Enter a task"
      />
      <button type="submit">Add</button>
    </form>
  );
};

const TaskItem = ({ task, onDelete, onToggleComplete }) => (
  <li className={task.completed ? 'completed' : ''}>
    <input
      type="checkbox"
      checked={task.completed}
      onChange={() => onToggleComplete(task.id)}
      className="task-checkbox"
    />
    <span className="task-text">{task.title}</span>
    <button className="delete-btn" onClick={() => onDelete(task.id)}>
      Delete
    </button>
  </li>
);

const TaskList = ({ tasks, onDelete, onToggleComplete }) => (
  <ul id="task-list">
    {tasks.map(task => (
      <TaskItem
        key={task.id}
        task={task}
        onDelete={onDelete}
        onToggleComplete={onToggleComplete}
      />
    ))}
  </ul>
);

const Stats = ({ total, completed, remaining }) => (
  <div id="stats">
    Total: {total} | Completed: {completed} | Remaining: {remaining}
  </div>
);

const Controls = ({
  showCompletedOnly,
  onToggleFilter,
  onClearCompleted,
}) => (
  <div>
    <button id="toggle-completed" onClick={onToggleFilter}>
      {showCompletedOnly ? 'Show all' : 'Show completed only'}
    </button>
    <button id="clear-completed" onClick={onClearCompleted}>
      Clear Completed
    </button>
  </div>
);

function App() {
  const [tasks, setTasks] = useState([]);
  const [showCompletedOnly, setShowCompletedOnly] = useState(false);

  useEffect(() => {
    fetch('https://jsonplaceholder.typicode.com/todos?_limit=3')
      .then(res => res.json())
      .then(data => {
        setTasks(
          data.map(item => ({
            id: item.id,
            title: item.title,
            completed: item.completed,
          }))
        );
      });
  }, []);

  const handleAddTask = title => {
    const newId = `local-${Date.now()}`;
    setTasks(prev => [...prev, { id: newId, title, completed: false }]);
  };

  const handleDeleteTask = id => {
    setTasks(prev => prev.filter(t => t.id !== id));
  };

  const handleToggleComplete = id => {
    setTasks(prev =>
      prev.map(t =>
        t.id === id ? { ...t, completed: !t.completed } : t
      )
    );
  };

  const handleToggleFilter = () => {
    setShowCompletedOnly(prev => !prev);
  };

  const handleClearCompleted = () => {
    setTasks(prev => prev.filter(t => !t.completed));
  };

  const visibleTasks = showCompletedOnly
    ? tasks.filter(t => t.completed)
    : tasks;

  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const remaining = total - completed;

  return (
    <div>
      <h1>Todo App</h1>
      <TaskInput onAdd={handleAddTask} />
      <Stats total={total} completed={completed} remaining={remaining} />
      <Controls
        showCompletedOnly={showCompletedOnly}
        onToggleFilter={handleToggleFilter}
        onClearCompleted={handleClearCompleted}
      />
      <TaskList
        tasks={visibleTasks}
        onDelete={handleDeleteTask}
        onToggleComplete={handleToggleComplete}
      />
    </div>
  );
}

export default App;