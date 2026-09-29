import React, { useState, useEffect } from 'react';

function TaskInput({ onAdd }) {
  const [value, setValue] = useState('');

  const handleAddClick = () => {
    const trimmed = value.trim();
    if (trimmed) {
      onAdd(trimmed);
      setValue('');
    }
  };

  return (
    <>
      <input
        type="text"
        id="task-input"
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="Enter a task"
      />
      <button id="add-btn" onClick={handleAddClick}>
        Add Task
      </button>
    </>
  );
}

function TaskList({ tasks, onDelete, onToggle }) {
  return (
    <ul id="task-list">
      {tasks.map(task => (
        <TaskItem
          key={task.id}
          task={task}
          onDelete={onDelete}
          onToggle={onToggle}
        />
      ))}
    </ul>
  );
}

function TaskItem({ task, onDelete, onToggle }) {
  return (
    <li className={task.completed ? 'completed' : ''}>
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

function Stats({ tasks }) {
  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const remaining = total - completed;
  const text = `Total: ${total} | Completed: ${completed} | Remaining: ${remaining}`;
  return <div id="stats">{text}</div>;
}

function Controls({ showCompletedOnly, onToggleShowCompleted, onClearCompleted }) {
  return (
    <div>
      <button id="toggle-completed" onClick={onToggleShowCompleted}>
        {showCompletedOnly ? 'Show all' : 'Show completed only'}
      </button>
      <button id="clear-completed" onClick={onClearCompleted}>
        Clear Completed
      </button>
    </div>
  );
}

function App() {
  const [tasks, setTasks] = useState([]);
  const [showCompletedOnly, setShowCompletedOnly] = useState(false);

  useEffect(() => {
    fetch('https://jsonplaceholder.typicode.com/todos?_limit=3')
      .then(res => res.json())
      .then(data => {
        const mapped = data.map(item => ({
          id: item.id,
          title: item.title,
          completed: item.completed
        }));
        setTasks(mapped);
      })
      .catch(console.error);
  }, []);

  const handleAdd = title => {
    const newTask = {
      id: 'local-' + Date.now(),
      title: title,
      completed: false
    };
    setTasks(prev => [...prev, newTask]);
  };

  const handleDelete = id => {
    setTasks(prev => prev.filter(t => t.id !== id));
  };

  const handleToggle = id => {
    setTasks(prev =>
      prev.map(t =>
        t.id === id ? { ...t, completed: !t.completed } : t
      )
    );
  };

  const handleToggleShow = () => {
    setShowCompletedOnly(prev => !prev);
  };

  const handleClearCompleted = () => {
    setTasks(prev => prev.filter(t => !t.completed));
  };

  const visibleTasks = showCompletedOnly
    ? tasks.filter(t => t.completed)
    : tasks;

  return (
    <div>
      <TaskInput onAdd={handleAdd} />
      <TaskList tasks={visibleTasks} onDelete={handleDelete} onToggle={handleToggle} />
      <Stats tasks={tasks} />
      <Controls
        showCompletedOnly={showCompletedOnly}
        onToggleShowCompleted={handleToggleShow}
        onClearCompleted={handleClearCompleted}
      />
    </div>
  );
}

export default App;